import { describe, expect, test } from "bun:test";
import {
	parseMarkerLines,
	routeMarkerInstructions,
	routeMarkerLines,
	type MarkerInstruction,
} from "../src/marker-parser";

describe("parseMarkerLines", () => {
	test("parses each supported operation marker", () => {
		expect(
			parseMarkerLines(
				"[query] MCP の認可を調べて [yuki.icon]\n" +
					"[ingest] この URL を取り込んで [yuki.icon]\n" +
					"[lint] 古いページを確認して [yuki.icon]",
			),
		).toEqual([
			{ kind: "query", text: "MCP の認可を調べて", children: [] },
			{ kind: "ingest", text: "この URL を取り込んで", children: [] },
			{ kind: "lint", text: "古いページを確認して", children: [] },
		]);
	});

	test("accepts a marker with no additional text", () => {
		expect(parseMarkerLines("[ingest][yuki.icon]")).toEqual([
			{ kind: "ingest", text: "", children: [] },
		]);
	});

	test("collects consecutive one-level-deeper child lines", () => {
		expect(
			parseMarkerLines(
				"[query] 調べる [yuki.icon]\n" +
					" 補足の条件\n" +
					"  さらに深い行は子行に含めない\n" +
					"通常の本文\n" +
					"[lint] 次に確認 [yuki.icon]",
			),
		).toEqual([
			{
				kind: "query",
				text: "調べる",
				children: ["補足の条件"],
			},
			{ kind: "lint", text: "次に確認", children: [] },
		]);
	});

	test("keeps every consecutive child line and strips only its level", () => {
		expect(
			parseMarkerLines(
				"[query] 調べる [yuki.icon]\n" +
					" 一行目\n" +
					" 二行目\n" +
					" 三行目",
			),
		).toEqual([
			{
				kind: "query",
				text: "調べる",
				children: ["一行目", "二行目", "三行目"],
			},
		]);
	});

	test("stops children at indentation and blank-line boundaries", () => {
		expect(
			parseMarkerLines(
				"[query] 最初 [yuki.icon]\n" +
					" 子行\n" +
					"  さらに深い行\n" +
					" 同じ見た目でも連続していない行\n" +
					"\n" +
					"[lint] 最後 [yuki.icon]",
			),
		).toEqual([
			{ kind: "query", text: "最初", children: ["子行"] },
			{ kind: "lint", text: "最後", children: [] },
		]);
	});

	test("does not let a child-looking line hide a later root marker", () => {
		expect(
			parseMarkerLines(
				"[query] 親 [yuki.icon]\n" +
					"  深い子行\n" +
					"[ingest] 別の指示 [yuki.icon]",
			),
		).toEqual([
			{ kind: "query", text: "親", children: [] },
			{ kind: "ingest", text: "別の指示", children: [] },
		]);
	});

	test("supports CRLF page bodies", () => {
		expect(
			parseMarkerLines(
				"[query] 改行をまたぐ [yuki.icon]\r\n" +
					" 子行\r\n" +
					"[lint] もう一つ [yuki.icon]",
			),
		).toEqual([
			{ kind: "query", text: "改行をまたぐ", children: ["子行"] },
			{ kind: "lint", text: "もう一つ", children: [] },
		]);
	});

	test("rejects markers that are not at line start", () => {
		expect(
			parseMarkerLines(
				" - [query] 箇条書きではない [yuki.icon]\n" +
					" [ingest] インデントされている [yuki.icon]\n" +
					"本文 [lint] 行末ではない [yuki.icon]",
			),
		).toEqual([]);
	});

	test("rejects markers whose icon is not exactly at line end", () => {
		expect(
			parseMarkerLines(
				"[query] アイコンの後に文字 [yuki.icon] まだ続く\n" +
					"[ingest] 別のアイコン [other.icon]\n" +
					"[lint] アイコンだけ次の行\n[yuki.icon]",
			),
		).toEqual([]);
	});

	test("keeps unmarked questions, monologues, and URLs inert", () => {
		expect(
			parseMarkerLines(
				"MCP の認可はどうなっていますか？ [yuki.icon]\n" +
					"ふと思ったことをメモしておく [yuki.icon]\n" +
					"https://example.com/query?q=lint [yuki.icon]\n" +
					"https://example.com/[query]/page\n" +
					"[query] 署名が無い",
			),
		).toEqual([]);
	});

	test("does not infer query for unknown or case-variant markers", () => {
		expect(
			parseMarkerLines(
				"[ask] これは別のマーカー [yuki.icon]\n" +
					"[QUERY] 大文字 [yuki.icon]\n" +
					"[queryish] 似た名前 [yuki.icon]",
			),
		).toEqual([]);
	});
});

describe("routeMarkerInstructions", () => {
	test("routes each kind into its operation bucket", () => {
		const instructions: MarkerInstruction[] = [
			{ kind: "lint", text: "L", children: [] },
			{ kind: "query", text: "Q1", children: [] },
			{ kind: "ingest", text: "I", children: ["child"] },
			{ kind: "query", text: "Q2", children: [] },
		];

		const routed = routeMarkerInstructions(instructions);
		expect(routed).toEqual({
			query: [instructions[1], instructions[3]],
			ingest: [instructions[2]],
			lint: [instructions[0]],
		});
	});

	test("routes parsed page lines without changing their order", () => {
		expect(
			routeMarkerLines(
				"[lint] L1 [yuki.icon]\n" +
					"[query] Q1 [yuki.icon]\n" +
					"[lint] L2 [yuki.icon]",
			),
		).toEqual({
			query: [{ kind: "query", text: "Q1", children: [] }],
			ingest: [],
			lint: [
				{ kind: "lint", text: "L1", children: [] },
				{ kind: "lint", text: "L2", children: [] },
			],
		});
	});
});
