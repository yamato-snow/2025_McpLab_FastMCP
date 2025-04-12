/**
 * FastMCPのシンプルな使用例
 * 
 * このファイルは、FastMCPを使って数値の加算を行う3つの方法を示しています：
 * 1. Zodバリデーションライブラリを使った方法
 * 2. ArkTypeバリデーションライブラリを使った方法
 * 3. Valibotバリデーションライブラリを使った方法
 * 
 * さらに、基本的なリソースとプロンプトの使用例も含まれています。
 */
import { FastMCP } from "../FastMCP.js";
import { z } from "zod";
import { type } from "arktype";
import * as v from "valibot";

// サーバーインスタンスの作成
const server = new FastMCP({
  name: "Addition",
  version: "1.0.0",
});

// --- Zod を使った例 ---
// Zodを使ってパラメータのバリデーションスキーマを定義
const AddParamsZod = z.object({
  a: z.number().describe("The first number"),
  b: z.number().describe("The second number"),
});

// Zodスキーマを使ったツールの追加
server.addTool({
  name: "add-zod",
  description: "Add two numbers (using Zod schema)",
  parameters: AddParamsZod,
  execute: async (args) => {
    // args は { a: number, b: number } 型として推論される
    console.log(`[Zod] Adding ${args.a} and ${args.b}`);
    return String(args.a + args.b);
  },
});

// --- ArkType を使った例 ---
// ArkTypeを使ってパラメータのバリデーションスキーマを定義
const AddParamsArkType = type({
  a: "number",
  b: "number",
});

// ArkTypeスキーマを使ったツールの追加
server.addTool({
  name: "add-arktype",
  description: "Add two numbers (using ArkType schema)",
  parameters: AddParamsArkType,
  execute: async (args) => {
    // args は AddParamsArkType.infer に基づいて { a: number, b: number } 型として推論される
    console.log(`[ArkType] Adding ${args.a} and ${args.b}`);
    return String(args.a + args.b);
  },
});

// --- Valibot を使った例 ---
// Valibotを使ってパラメータのバリデーションスキーマを定義
const AddParamsValibot = v.object({
  a: v.number("The first number"),
  b: v.number("The second number"),
});

// Valibotスキーマを使ったツールの追加
server.addTool({
  name: "add-valibot",
  description: "Add two numbers (using Valibot schema)",
  parameters: AddParamsValibot,
  execute: async (args) => {
    console.log(`[Valibot] Adding ${args.a} and ${args.b}`);
    return String(args.a + args.b);
  },
});

// リソースの追加例
// このリソースはアプリケーションログを提供する
server.addResource({
  uri: "file:///logs/app.log",
  name: "Application Logs",
  mimeType: "text/plain",
  async load() {
    return {
      text: "Example log content",
    };
  },
});

// プロンプトの追加例
// このプロンプトはGitコミットメッセージの生成を支援する
server.addPrompt({
  name: "git-commit",
  description: "Generate a Git commit message",
  arguments: [
    {
      name: "changes",
      description: "Git diff or description of changes",
      required: true,
    },
  ],
  load: async (args) => {
    return `Generate a concise but descriptive commit message for these changes:\n\n${args.changes}`;
  },
});

// 標準入出力(stdio)トランスポートでサーバーを起動
server.start({
  transportType: "stdio",
});
