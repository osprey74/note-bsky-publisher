#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';

const STATE_PATH = 'auth/note-storage-state.json';
const LOGIN_URL = 'https://note.com/login';

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();

  await page.goto(LOGIN_URL);

  process.stdout.write(
    '\n----- note ログイン -----\n' +
    'ブラウザに note のログイン画面を開きました。\n' +
    'ID/パスワードまたは外部認証でログインしてください。\n' +
    'ログイン完了後、このターミナルで Enter を押すとセッションを保存します。\n\n'
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Enter で続行 > ');
  rl.close();

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await context.storageState({ path: STATE_PATH });

  process.stdout.write(`\nセッションを保存しました: ${STATE_PATH}\n`);
  process.stdout.write('このファイルは .gitignore で除外されており、リポジトリには含まれません。\n');

  await browser.close();
}
