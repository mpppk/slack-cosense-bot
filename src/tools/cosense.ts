import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { allowedProjects, projectUrl } from "../config";
import {
	buildOpsJson,
	checkNotationCollisions,
	checkOpsCollisions,
	cosenseEditOpSchema,
	formatCollisionReport,
} from "../cosense-edit";
import { sanitizeText, threadErrorMessage } from "../errors";
import {
	BINDING_FORMAT_GUIDE,
	extractProjectNameFromToken,
	resolveProjects,
} from "../project-binding";
import { runCosense, runCosenseWithInputFile, truncate } from "../sandbox";

/**
 * 書き込みツール (Issue #15, owner gate: APPROVED)。
 *
 * 読み取り系ツールに加えて previewEdit / previewNewPage / submitEdit を公開
 * する。ワークフローは必ず preview → 検証 → submit の順で、submit 単独で
 * ページを書き換える経路は作らない。ops JSON と新規ページ本文は
 * runCosenseWithInputFile() 経由でのみ CLI へ渡す (ページ本文がシェルに
 * 届く経路を作らない — `printf |` やヒアドキュメントは禁止)。
 *
 * チャンネル ↔ プロジェクトは多対多。description の `cosense:` 行に
 * 複数書ける (例: `cosense: niki-auth, niki-ai`)。検索系は既定で紐づく
 * 全プロジェクトを横断し、ページ指定系・書き込み系は project パラメータで
 * 1つに絞る (紐づけが1つだけなら省略可)。
 */

interface ToolContext {
	env: Env;
	/** Slack channel id for the current turn, from getMessengerContext(). */
	channelId: () => string | undefined;
	/**
	 * @deprecated プロジェクト紐づけは決定的パースになりモデルを使わない。
	 * 既存テストとの互換のためだけに残している。
	 */
	model?: unknown;
}

type ResolvedTargets =
	| { projects: string[]; warning?: string }
	| { error: string };

/**
 * Resolve the projects for this turn, or return the message the agent should
 * say instead of running the command.
 *
 * 決定事項: description にプロジェクトが書かれていない場合はスレッド内で聞き返す。
 * So an unresolved binding is a normal tool result, not an error — the model
 * reads it and asks the user.
 */
async function requireProjects(ctx: ToolContext): Promise<ResolvedTargets> {
	const channelId = ctx.channelId();
	if (!channelId) {
		return { error: "Slack のチャンネルを特定できませんでした。" };
	}

	const resolution = await resolveProjects(ctx.env, channelId);
	switch (resolution.kind) {
		case "resolved": {
			const warning =
				resolution.rejected && resolution.rejected.length > 0
					? `注意: description の "${resolution.rejected.join(", ")}" はこのbotが参照できるプロジェクトに含まれないため無視しました。`
					: undefined;
			return { projects: resolution.projects, warning };
		}
		case "rejected":
			return {
				error:
					`description は "${resolution.candidates.join(", ")}" を指していますが、` +
					`このbotが参照できるプロジェクトに含まれていません。` +
					`許可されているのは ${ctx.env.COSENSE_PROJECTS} です。` +
					BINDING_FORMAT_GUIDE,
			};
		case "unset":
			return {
				error:
					`このチャンネルに Cosense プロジェクトが紐づいていません (${resolution.reason})。` +
					`ユーザーにどのプロジェクトを見ればよいか尋ねてください。`,
			};
	}
}

/**
 * tool の project パラメータを正規化する。プロジェクト名でも URL でもよい。
 * 未指定ならチャンネルの紐づけを使う。
 */
async function resolveTargetProjects(
	ctx: ToolContext,
	requested?: string,
): Promise<ResolvedTargets> {
	const trimmed = requested?.trim();
	if (trimmed) {
		const normalized = extractProjectNameFromToken(trimmed);
		if (!normalized) {
			return {
				error:
					`project "${trimmed}" からプロジェクト名を読み取れませんでした。` +
					`プロジェクト名 (例: niki-auth) か URL で指定してください。`,
			};
		}
		if (!allowedProjects(ctx.env).includes(normalized)) {
			return {
				error:
					`project "${normalized}" はこのbotが参照できるプロジェクトに含まれていません。` +
					`許可されているのは ${ctx.env.COSENSE_PROJECTS} です。`,
			};
		}
		return { projects: [normalized] };
	}
	return requireProjects(ctx);
}

/**
 * ページ指定系・書き込み系用に1プロジェクトに絞る。紐づけが複数のまま
 * project 指定が無い場合は、エージェントに選び直させるメッセージを返す。
 */
async function requireSingleProject(
	ctx: ToolContext,
	requested?: string,
): Promise<{ project: string; warning?: string } | { error: string }> {
	const targets = await resolveTargetProjects(ctx, requested);
	if ("error" in targets) return targets;
	if (targets.projects.length === 1 && targets.projects[0] !== undefined) {
		return { project: targets.projects[0], warning: targets.warning };
	}
	return {
		error:
			`このチャンネルには複数のプロジェクト (${targets.projects.join(", ")}) が紐づいています。` +
			`project パラメータでどれを使うか指定してください (例: project: "${targets.projects[0]}")。`,
	};
}

function withWarning(warning: string | undefined, text: string): string {
	return warning ? `${warning}\n\n${text}` : text;
}

/**
 * Failure text for a non-zero cosense exit. Exported for unit tests.
 *
 * stderr is sanitized BEFORE truncation so a secret near the head of a long
 * log cannot survive, and the exit code plus subcommand name keep the Sandbox
 * origin distinguishable in the thread.
 */
export function formatCosenseFailure(
	args: string[],
	stderr: string,
	exitCode: number,
): string {
	const subcommand = args[0] ?? "cosense";
	return `cosense ${subcommand} が失敗しました (exit ${exitCode}): ${truncate(sanitizeText(stderr), 2_000)}`;
}

/**
 * Run a cosense subcommand, folding both failure modes into readable text.
 *
 * Non-zero exits become sanitized tool text (the model relays the cause in
 * the thread). A thrown launch failure — Sandbox startup, PAT/origin
 * validation — never reaches the thread raw: it becomes the Sandbox 系
 * classified定型文 so the model repeats a safe, distinguishable message.
 */
async function cosenseText(
	env: Env,
	project: string,
	args: string[],
	maxChars?: number,
): Promise<string> {
	let result: Awaited<ReturnType<typeof runCosense>>;
	try {
		result = await runCosense(env, project, args);
	} catch {
		return threadErrorMessage("sandbox");
	}
	if (!result.ok) {
		return formatCosenseFailure(args, result.stderr, result.exitCode);
	}
	return truncate(result.stdout, maxChars);
}

/**
 * Run a cosense subcommand with free-text input (ops JSON or new-page body).
 *
 * The content reaches the container through the writeFile RPC and the CLI
 * reads it back with --input-file; failures fold into readable text the same
 * way cosenseText does (sanitized preview of stderr, or the Sandbox系定型文
 * when the Sandbox itself fails to launch).
 */
async function cosensePreviewText(
	env: Env,
	project: string,
	buildArgs: (inputPath: string) => string[],
	content: string,
	maxChars?: number,
): Promise<string> {
	let result: Awaited<ReturnType<typeof runCosenseWithInputFile>>;
	try {
		result = await runCosenseWithInputFile(env, project, buildArgs, content);
	} catch {
		return threadErrorMessage("sandbox");
	}
	if (!result.ok) {
		// buildArgs is only invoked here for a stable subcommand label; the
		// temp path inside is never surfaced to the thread.
		const label = buildArgs("input-file")[0] ?? "cosense";
		return formatCosenseFailure([label], result.stderr, result.exitCode);
	}
	return truncate(result.stdout, maxChars);
}

/**
 * 検索系: 紐づく全プロジェクトを横断する。1件なら従来通りそのまま返し、
 * 複数なら `【project】` 見出し付きで連結する。一部の失敗はその
 * プロジェクトの欄に畳み、全体は止めない。
 */
async function searchAcrossProjects(
	ctx: ToolContext,
	projects: string[],
	buildArgs: (projectUrlValue: string) => string[],
	warning?: string,
	maxChars?: number,
): Promise<string> {
	if (projects.length === 1 && projects[0] !== undefined) {
		const single = projects[0];
		const text = await cosenseText(
			ctx.env,
			single,
			buildArgs(projectUrl(ctx.env, single)),
			maxChars,
		);
		return withWarning(warning, text);
	}
	const results = await Promise.all(
		projects.map(async (project) => ({
			project,
			text: await cosenseText(
				ctx.env,
				project,
				buildArgs(projectUrl(ctx.env, project)),
				maxChars,
			),
		})),
	);
	return withWarning(
		warning,
		results.map(({ project, text }) => `--- 【${project}】\n${text}`).join("\n\n"),
	);
}

const projectParamDescription =
	"Cosenseプロジェクト名 (例: niki-auth)。URLでも可。省略時はチャンネルの紐づけを使う。チャンネルに複数プロジェクトが紐づく場合は必須";

export function createCosenseTools(ctx: ToolContext): ToolSet {
	return {
		searchVector: tool({
			description:
				"意味の近い Cosense ページを探す。何を読むべきか当たりを付ける最初の一手。" +
				"意味検索なので、特定タイトルの存在確認には使えない。" +
				"チャンネルに複数プロジェクトが紐づく場合は既定で全てを横断する。" +
				"project を指定するとその1つだけに絞る。",
			inputSchema: z.object({
				query: z.string().describe("探したい内容を表す語句や文"),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ query, project }) => {
				const targets = await resolveTargetProjects(ctx, project);
				if ("error" in targets) return targets.error;
				return searchAcrossProjects(
					ctx,
					targets.projects,
					(projectUrlValue) => ["searchVector", projectUrlValue, query],
					targets.warning,
				);
			},
		}),

		searchFullText: tool({
			description:
				"Cosense の本文を全文検索する。語句が確定しているときに使う。" +
				"結果にはタイトルが 📄 で始まる、または本文1行目が #bookmark の source ページが混ざる。既定では読み飛ばす。" +
				"チャンネルに複数プロジェクトが紐づく場合は既定で全てを横断する。" +
				"project を指定するとその1つだけに絞る。",
			inputSchema: z.object({
				query: z.string().describe("検索する語句"),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ query, project }) => {
				const targets = await resolveTargetProjects(ctx, project);
				if ("error" in targets) return targets.error;
				return searchAcrossProjects(
					ctx,
					targets.projects,
					(projectUrlValue) => ["searchFullText", projectUrlValue, query],
					targets.warning,
				);
			},
		}),

		browsePage: tool({
			description:
				"Cosense のページ1枚を読む。メタデータ・アイコン記法・Infobox・本文と、" +
				"末尾に関連ページ一覧が付く。検索で見つけたページの本体を読むときに使う。" +
				"チャンネルに複数プロジェクトが紐づく場合は project が必須。1つの場合は省略可。",
			inputSchema: z.object({
				title: z.string().describe("ページタイトル（URL ではなくタイトルそのまま）"),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ title, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				const text = await cosenseText(
					ctx.env,
					resolved.project,
					[
						"browsePage",
						`${projectUrl(ctx.env, resolved.project)}/${encodeURIComponent(title)}`,
					],
					20_000,
				);
				return withWarning(resolved.warning, text);
			},
		}),

		list1hopLinks: tool({
			description:
				"ページの 1-hop 近傍（外向きリンクと被リンク）を取得する。単独ページでは見えない文脈を辿るときに使う。" +
				"本文の無い空ページは現れない。" +
				"チャンネルに複数プロジェクトが紐づく場合は project が必須。1つの場合は省略可。",
			inputSchema: z.object({
				title: z.string().describe("起点にするページタイトル"),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ title, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				const text = await cosenseText(ctx.env, resolved.project, [
					"list1hopLinks",
					`${projectUrl(ctx.env, resolved.project)}/${encodeURIComponent(title)}`,
				]);
				return withWarning(resolved.warning, text);
			},
		}),

		browseRelatedPages: tool({
			description:
				"型定義ページ (summary / thesis / idea) の Infobox 表を TSV で取得する。" +
				"全 summary の一覧など、索引が欲しいときに使う。" +
				"個々の summary / thesis ページには使わない（捏造値を含む表が出る）。" +
				"チャンネルに複数プロジェクトが紐づく場合は project が必須。1つの場合は省略可。",
			inputSchema: z.object({
				title: z
					.string()
					.describe("型定義ページのタイトル。summary / thesis / idea のいずれか"),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ title, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				const text = await cosenseText(ctx.env, resolved.project, [
					"browseRelatedPages",
					`${projectUrl(ctx.env, resolved.project)}/${encodeURIComponent(title)}`,
				]);
				return withWarning(resolved.warning, text);
			},
		}),

		previewEdit: tool({
			description:
				"既存ページへの編集を dry-run する。ops (insertBefore / replace / delete) " +
				"を組み立てて previewId を取得する。ページはまだ変わらない。" +
				"結果の適用後ページ全体を確認し、問題が無ければ submitEdit で確定する。" +
				"submitEdit なしに編集が反映されることは無い。新規ページは previewNewPage を使う。" +
				"ページの作成・編集はユーザーが明示的に指示したときのみ行う。" +
				"ingest では URL 貼りが明示指示 (§13) だが、takeaways 確認 (手順2) が済むまで " +
				"summary 以降の書き込みには使わない。generated な summary を thesis の " +
				"supported_by / refuted_by に入れない (§13)。done / dropped の idea は触らない (§8)。" +
				"[question] の孤立防止 (§4) で関係する [concept] から被リンクを張るときにも使う。" +
				"チャンネルに複数プロジェクトが紐づく場合は project が必須。1つの場合は省略可。",
			inputSchema: z.object({
				pageId: z
					.string()
					.min(1)
					.describe("編集対象ページのID（readPage 出力の top-level id）"),
				ops: z
					.array(cosenseEditOpSchema)
					.min(1)
					.describe(
						"編集操作の配列。insertBefore は行IDまたは末尾用の _end を anchor に取り " +
							"複数行 text も可、replace は行IDに単行 text のみ、delete は行IDのみ。",
					),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ pageId, ops, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				let opsJson: string;
				try {
					opsJson = buildOpsJson(ops);
				} catch (error) {
					return error instanceof Error
						? `ops が不正です: ${error.message}`
						: "ops が不正です";
				}
				const report = formatCollisionReport(checkOpsCollisions(ops));
				const preview = await cosensePreviewText(
					ctx.env,
					resolved.project,
					(inputPath) => [
						"previewEdit",
						"--input-file",
						inputPath,
						projectUrl(ctx.env, resolved.project),
						pageId,
					],
					opsJson,
					20_000,
				);
				const body = report === "" ? preview : `${report}\n\n---\n\n${preview}`;
				return withWarning(resolved.warning, body);
			},
		}),

		previewNewPage: tool({
			description:
				"新規ページ作成を dry-run する (previewEdit --new)。本文の1行目がページタイトル、" +
				"2行目以降が本文になる。ページはまだ作られない。" +
				"結果を確認し、問題が無ければ submitEdit で確定する。" +
				"ページの作成はユーザーが明示的に指示したときのみ行う (ingest の URL 貼りは明示指示 §13)。" +
				"再利用価値のある回答の [question] 化 (§14 query 手順4) にも使う。" +
				"LLM の判断で idea を新規作成しない (§8)。" +
				"チャンネルに複数プロジェクトが紐づく場合は project が必須。1つの場合は省略可。",
			inputSchema: z.object({
				body: z
					.string()
					.min(1)
					.describe(
						"新規ページの全文。1行目がタイトル、2行目以降が本文。型は本文1行目に1つだけ書く。",
					),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ body, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				const report = formatCollisionReport(checkNotationCollisions(body));
				const preview = await cosensePreviewText(
					ctx.env,
					resolved.project,
					(inputPath) => [
						"previewEdit",
						"--new",
						"--input-file",
						inputPath,
						projectUrl(ctx.env, resolved.project),
					],
					body,
					20_000,
				);
				const text = report === "" ? preview : `${report}\n\n---\n\n${preview}`;
				return withWarning(resolved.warning, text);
			},
		}),

		submitEdit: tool({
			description:
				"previewEdit / previewNewPage で取得した previewId を確定してページに反映する。" +
				"直前の preview の内容を必ず確認してから呼ぶこと。previewId は1回限りで5分で期限切れになる。" +
				"preview を作り直したら古い previewId は使えない。ページの作成・編集は " +
				"ユーザーが明示的に指示したときのみ行い、削除の確定には使わない。" +
				"ingest の submit は takeaways 確認 (手順2) が済んでから。" +
				"[question] の submit は再利用判定と適用後ページの確認が済んでから (§14 query 手順4) 。" +
				"チャンネルに複数プロジェクトが紐づく場合は preview と同じ project を指定する。",
			inputSchema: z.object({
				previewId: z
					.string()
					.min(1)
					.describe(
						"直前の previewEdit / previewNewPage が返した previewId",
					),
				project: z.string().optional().describe(projectParamDescription),
			}),
			execute: async ({ previewId, project }) => {
				const resolved = await requireSingleProject(ctx, project);
				if ("error" in resolved) return resolved.error;
				const text = await cosenseText(
					ctx.env,
					resolved.project,
					[
						"submitEdit",
						projectUrl(ctx.env, resolved.project),
						previewId,
					],
					20_000,
				);
				return withWarning(resolved.warning, text);
			},
		}),
	};
}
