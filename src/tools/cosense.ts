import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { projectUrl } from "../config";
import { resolveProject } from "../project-binding";
import { runCosense, truncate } from "../sandbox";

/**
 * MVP のツールセット。
 *
 * 決定事項: MVP は「Slack で mention → Cosense を読んで回答」まで。書き込みは含めない。
 * previewEdit / submitEdit は意図的に公開していない。ingest 一式を解禁するのは、
 * このモデルの規約遵守度を MVP で測ってからである。
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

/** Run a cosense subcommand, folding both failure modes into readable text. */
async function cosenseText(
	env: Env,
	args: string[],
	maxChars?: number,
): Promise<string> {
	const result = await runCosense(env, args);
	if (!result.ok) {
		return `cosense ${args[0]} が失敗しました (exit ${result.exitCode}): ${truncate(result.stderr, 2_000)}`;
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
		return cosenseText(ctx.env, build(projectUrl(ctx.env, resolved.project)), maxChars);
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
	};
}
