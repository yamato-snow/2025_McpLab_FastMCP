#!/usr/bin/env node

/**
 * FastMCP CLI ツール
 * 
 * このファイルは、FastMCPサーバーを簡単に起動・デバッグするためのコマンドラインインターフェースを提供します。
 * 主に以下の2つのコマンドを提供します：
 * - dev: 開発用サーバーを起動（mcp-cliを使用）
 * - inspect: MCPインスペクターを使ってサーバーを検査
 */
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { execa } from "execa";

await yargs(hideBin(process.argv))
  .scriptName("fastmcp")
  .command(
    "dev <file>",
    "Start a development server",
    (yargs) => {
      return yargs.positional("file", {
        type: "string",
        describe: "The path to the server file",
        demandOption: true,
      });
    },
    async (argv) => {
      try {
        // mcp-cliを使用してサーバーファイルを実行
        // 標準入出力を継承してインタラクティブに操作できるようにする
        await execa({
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })`npx @wong2/mcp-cli npx tsx ${argv.file}`;
      } catch {
        process.exit(1);
      }
    },
  )
  .command(
    "inspect <file>",
    "Inspect a server file",
    (yargs) => {
      return yargs.positional("file", {
        type: "string",
        describe: "The path to the server file",
        demandOption: true,
      });
    },
    async (argv) => {
      try {
        // MCP Inspectorを使用してサーバーを検査
        // ウェブUIを通じてサーバーの機能をテストできる
        await execa({
          stdout: "inherit",
          stderr: "inherit",
        })`npx @modelcontextprotocol/inspector npx tsx ${argv.file}`;
      } catch {
        process.exit(1);
      }
    },
  )
  .help()
  .parseAsync();
