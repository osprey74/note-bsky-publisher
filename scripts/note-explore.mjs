#!/usr/bin/env node
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';

const STATE_PATH = 'auth/note-storage-state.json';
const OBSERVATION_PATH = 'auth/note-observation.json';
const SCREENSHOT_PATH = 'auth/note-observation.png';

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: STATE_PATH,
    locale: 'ja-JP',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  await page.goto('https://note.com/');

  process.stdout.write(
    '\n----- note エディタ観察モード -----\n' +
    'note のホーム画面を開きました（ログイン済みのはず）。\n' +
    '\n' +
    '次の手順で観察してください：\n' +
    '  1. 右上の「投稿」→「テキスト」をクリックして新規記事画面へ移動\n' +
    '  2. DevTools (F12) を開く\n' +
    '  3. 以下を試して構造を観察：\n' +
    '     - タイトル欄をクリックして要素を Inspect\n' +
    '     - 本文欄をクリックして要素を Inspect\n' +
    '     - 「画像を追加」のヘッダー画像エリアを Inspect\n' +
    '     - 試しに Markdown を貼り付けて変換のされ方を確認\n' +
    '       （見出し # 段落 リスト - リンク [text](url) など）\n' +
    '     - 「公開設定」モーダルを開いてハッシュタグ入力欄を確認\n' +
    '     - 「下書き保存」ボタンの位置を確認\n' +
    '\n' +
    '観察が終わったら、このターミナルで Enter を押すと\n' +
    '現在のページの DOM 情報をダンプ＋スクリーンショット保存して終了します。\n\n'
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Enter で観察結果をダンプ > ');
  rl.close();

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

  const obs = await observeCurrentPage(page);
  await writeFile(OBSERVATION_PATH, JSON.stringify(obs, null, 2), 'utf-8');

  process.stdout.write('\n--- 観察結果サマリ ---\n');
  process.stdout.write(`URL          : ${obs.url}\n`);
  process.stdout.write(`タイトル      : ${obs.title}\n`);
  process.stdout.write(`contenteditable: ${obs.contentEditables.length} 個\n`);
  process.stdout.write(`textarea     : ${obs.textareas.length} 個\n`);
  process.stdout.write(`input        : ${obs.inputs.length} 個\n`);
  process.stdout.write(`button       : ${obs.buttons.length} 個（先頭 50 個まで記録）\n`);
  process.stdout.write(`placeholder  : ${obs.placeholders.length} 個\n`);
  process.stdout.write(`\nファイル保存:\n`);
  process.stdout.write(`  ${OBSERVATION_PATH}\n`);
  process.stdout.write(`  ${SCREENSHOT_PATH}\n`);

  await browser.close();
}

async function observeCurrentPage(page) {
  return await page.evaluate(() => {
    const truncate = (s, n) => (s ?? '').toString().slice(0, n);
    const text = (el) => truncate((el.innerText ?? el.textContent ?? '').trim(), 120);
    const attrs = (el) =>
      Object.fromEntries(
        [...el.attributes].map((a) => [a.name, truncate(a.value, 200)]),
      );
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      attrs: attrs(el),
      text: text(el),
    });

    return {
      url: location.href,
      title: document.title,
      contentEditables: [...document.querySelectorAll('[contenteditable="true"]')].map(describe),
      textareas: [...document.querySelectorAll('textarea')].map(describe),
      inputs: [...document.querySelectorAll('input')].map((el) => ({
        tag: 'input',
        type: el.type,
        attrs: attrs(el),
        value: truncate(el.value, 120),
      })),
      buttons: [...document.querySelectorAll('button')].slice(0, 50).map(describe),
      placeholders: [...document.querySelectorAll('[placeholder]')].map((el) => ({
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute('placeholder'),
        attrs: attrs(el),
      })),
      ariaLabels: [...document.querySelectorAll('[aria-label]')].slice(0, 50).map((el) => ({
        tag: el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
      })),
    };
  });
}
