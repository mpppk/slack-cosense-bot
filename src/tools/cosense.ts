import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { projectUrl } from "../config";
import {
	buildOpsJson,
	checkNotationCollisions,
	checkOpsCollisions,
	cosenseEditOpSchema,
	formatCollisionReport,
} from "../cosense-edit";
import { sanitizeText, threadErrorMessage } from "../errors";
import { resolveProject } from "../project-binding";
import { runCosense, runCosenseWithInputFile, truncate } from "../sandbox";

/**
 * 書き込みツール (Issue #15, owner gate: APPROVED)。
 *
 * 読み取り系ツールに加えて previewEdit / previewNewPage / submitEdit を公開
 * する。ワークフローは必ず preview → 検証 → submit の順で、submit 単独で
 * ページを書き換える経路は作らない。ops JSON と新規ページ本文は
 * runCosenseWithInputFile() 経由でのみ CLI へ渡す (ページ本文がシェルに
 * 届く経路を作らない — `printf |` やヒアドキュメントは禁止)。
 */

interface ToolContext {
	env: Env;
	model: LanguageModel;
	/** Slack channel id for the current turn, from getMessengerContext(). */
	channelId: () => string | undefined;
}

/**
 * Resolve the project for this turn, or return the message the agent should
 * say instead of running the command.
 *
 * 決定事項: description にプロジェクトが書かれていない場合はスレッド内で聞き返す。
 * So an unresolved binding is a normal tool result, not an error — the model
 * reads it and asks the user.
 */
async function requireProject(
	ctx: ToolContext,
): Promise<{ project: string } | { error: string }> {
	const channelId = ctx.channelId();
	if (!channelId) {
		return { error: "Slack のチャンネルを特定できませんでした。" };
	}

	const resolution = await resolveProject(ctx.env, ctx.model, channelId);
	switch (resolution.kind) {
		case "resolved":
			return { project: resolution.project };
		case "rejected":
			return {
				error:
					`description は "${resolution.candidate}" を指していますが、` +
					`このbotが参照できるプロジェクトに含まれていません。` +
					`許可されているのは ${ctx.env.COSENSE_PROJECTS} です。`,
			};
		case "unset":
			return {
				error:
					`このチャンネルに Cosense プロジェクトが紐づいていません (${resolution.reason})。` +
					`チャンネルの description に対象プロジェクトの URL を書いてください。` +
					`ユーザーにどのプロジェクトを見ればよいか尋ねてください。`,
			};
	}
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

export function createCosenseTools(ctx: ToolContext): ToolSet {
	const withProject = async (
		build: (projectUrlValue: string) => string[],
		maxChars?: number,
	): Promise<string> => {
		const resolved = await requireProject(ctx);
		if ("error" in resolved) return resolved.error;
		return cosenseText(
			ctx.env,
			resolved.project,
			build(projectUrl(ctx.env, resolved.project)),
			maxChars,
		);
	};

	return {
		searchVector: tool({
			description:
				"意味の近い Cosense ページを探す。何を読むべきか当たりを付ける最初の一手。" +
				"意味検索なので、特定タイトルの存在確認には使えない。",
			inputSchema: z.object({
				query: z.string().describe("探したい内容を表す語句や文"),
			}),
			execute: ({ query }) =>
				withProject((project) => ["searchVector", project, query]),
		}),

		searchFullText: tool({
			description:
				"Cosense の本文を全文検索する。語句が確定しているときに使う。" +
				"結果にはタイトルが 📄 で始まる、または本文1行目が #bookmark の source ページが混ざる。既定では読み飛ばす。",
			inputSchema: z.object({
				query: z.string().describe("検索する語句"),
			}),
			execute: ({ query }) =>
				withProject((project) => ["searchFullText", project, query]),
		}),

		browsePage: tool({
			description:
				"Cosense のページ1枚を読む。メタデータ・アイコン記法・Infobox・本文と、" +
				"末尾に関連ページ一覧が付く。検索で見つけたページの本体を読むときに使う。",
			inputSchema: z.object({
				title: z.string().describe("ページタイトル（URL ではなくタイトルそのまま）"),
			}),
			execute: ({ title }) =>
				withProject(
					(project) => ["browsePage", `${project}/${encodeURIComponent(title)}`],
					20_000,
				),
		}),

		list1hopLinks: tool({
			description:
				"ページの 1-hop 近傍（外向きリンクと被リンク）を取得する。単独ページでは見えない文脈を辿るときに使う。" +
				"本文の無い空ページは現れない。",
			inputSchema: z.object({
				title: z.string().describe("起点にするページタイトル"),
			}),
			execute: ({ title }) =>
				withProject((project) => [
					"list1hopLinks",
					`${project}/${encodeURIComponent(title)}`,
				]),
		}),

		browseRelatedPages: tool({
			description:
				"型定義ページ (summary / thesis / idea) の Infobox 表を TSV で取得する。" +
				"全 summary の一覧など、索引が欲しいときに使う。" +
				"個々の summary / thesis ページには使わない（捏造値を含む表が出る）。",
			inputSchema: z.object({
				title: z
					.string()
					.describe("型定義ページのタイトル。summary / thesis / idea のいずれか"),
			}),
			execute: ({ title }) =>
				withProject((project) => [
					"browseRelatedPages",
					`${project}/${encodeURIComponent(title)}`,
				]),
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
				"[question] の孤立防止 (§4) で関係する [concept] から被リンクを張るときにも使う。",
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
			}),
			execute: async ({ pageId, ops }) => {
				const resolved = await requireProject(ctx);
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
				return report === "" ? preview : `${report}\n\n---\n\n${preview}`;
			},
		}),

		previewNewPage: tool({
			description:
				"新規ページ作成を dry-run する (previewEdit --new)。本文の1行目がページタイトル、" +
				"2行目以降が本文になる。ページはまだ作られない。" +
				"結果を確認し、問題が無ければ submitEdit で確定する。" +
				"ページの作成はユーザーが明示的に指示したときのみ行う (ingest の URL 貼りは明示指示 §13)。" +
				"再利用価値のある回答の [question] 化 (§14 query 手順4) にも使う。" +
				"LLM の判断で idea を新規作成しない (§8)。",
			inputSchema: z.object({
				body: z
					.string()
					.min(1)
					.describe(
						"新規ページの全文。1行目がタイトル、2行目以降が本文。型は本文1行目に1つだけ書く。",
					),
			}),
			execute: async ({ body }) => {
				const resolved = await requireProject(ctx);
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
				return report === "" ? preview : `${report}\n\n---\n\n${preview}`;
			},
		}),

		submitEdit: tool({
			description:
				"previewEdit / previewNewPage で取得した previewId を確定してページに反映する。" +
				"直前の preview の内容を必ず確認してから呼ぶこと。previewId は1回限りで5分で期限切れになる。" +
				"preview を作り直したら古い previewId は使えない。ページの作成・編集は " +
				"ユーザーが明示的に指示したときのみ行い、削除の確定には使わない。" +
				"ingest の submit は takeaways 確認 (手順2) が済んでから。" +
				"[question] の submit は再利用判定と適用後ページの確認が済んでから (§14 query 手順4) 。",
			inputSchema: z.object({
				previewId: z
					.string()
					.min(1)
					.describe(
						"直前の previewEdit / previewNewPage が返した previewId",
					),
			}),
			execute: ({ previewId }) =>
				withProject(
					(project) => ["submitEdit", project, previewId],
					20_000,
				),
		}),
	};
}
