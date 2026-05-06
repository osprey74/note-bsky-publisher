#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const STATE_PATH = 'auth/note-storage-state.json';

const HELP = `\
Usage:
  node scripts/publish-note.mjs --file <markdown-path> [--keep-open]

Options:
  --file, -f      公開する Markdown 記事のパス
  --keep-open     完了後ブラウザを閉じない（手動確認用）
  --help, -h      ヘルプ

フロントマター（YAML）でヘッダー画像とハッシュタグを指定できます:
  ---
  header_image: header_images/xxx.png
  hashtags: [Tag1, Tag2]
  ---
`;

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', short: 'f' },
      'keep-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) { process.stdout.write(HELP); return; }
  if (!values.file) {
    process.stderr.write('エラー: --file を指定してください\n\n' + HELP);
    process.exitCode = 1;
    return;
  }

  const mdPath = resolve(values.file);
  const raw = await readFile(mdPath, 'utf-8');
  const { meta, body: rawBody } = parseFrontmatter(raw);
  const cleaned = stripHtmlComments(rawBody);
  const { title, body } = extractTitle(cleaned);
  const hashtags = (meta.hashtags ?? []).slice(0, 5);
  const headerImage = meta.header_image ? resolve(meta.header_image) : null;

  process.stdout.write('--- 解析結果 ---\n');
  process.stdout.write(`タイトル     : ${title}\n`);
  process.stdout.write(`ヘッダー画像 : ${headerImage ?? '(なし)'}\n`);
  process.stdout.write(`ハッシュタグ : ${hashtags.length ? hashtags.map((t) => '#' + t).join(' ') : '(なし)'}\n`);
  process.stdout.write(`本文文字数   : ${body.length}\n\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({
    storageState: STATE_PATH,
    locale: 'ja-JP',
    viewport: { width: 1400, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  await openEditor(page);
  if (headerImage) await uploadHeaderImage(page, headerImage);
  await fillTitle(page, title);
  await fillBody(page, body, hashtags);
  const articleUrl = await saveDraft(page);

  process.stdout.write(`\n下書き保存しました\n`);
  process.stdout.write(`記事 URL: ${articleUrl}\n`);

  if (!values['keep-open']) {
    await browser.close();
  } else {
    process.stdout.write('\n--keep-open 指定のためブラウザを開いたままにします。Ctrl+C で終了。\n');
  }
}

// ---------- markdown 解析 ----------

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { meta: {}, body: content };
  return { meta: parseSimpleYaml(m[1]), body: content.slice(m[0].length) };
}

function parseSimpleYaml(text) {
  const meta = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    meta[m[1]] = parseYamlValue(m[2].trim());
  }
  return meta;
}

function parseYamlValue(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return v.replace(/^["']|["']$/g, '');
}

function stripHtmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (!m) return { title: '', body: body.trim() };
  return { title: m[1].trim(), body: body.replace(m[0], '').trim() };
}

// ---------- ブラウザ操作 ----------

async function openEditor(page) {
  const candidates = [
    'https://editor.note.com/new',
    'https://note.com/new',
    'https://note.com/notes/new',
  ];
  for (const url of candidates) {
    process.stdout.write(`エディタ URL を試行: ${url}\n`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ok = await page.waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 5000 }).catch(() => null);
    if (ok) {
      process.stdout.write(`エディタを開きました: ${page.url()}\n`);
      return;
    }
  }
  process.stdout.write('直接 URL では開けず。ホームから「投稿 → テキスト」で遷移します。\n');
  await page.goto('https://note.com/', { waitUntil: 'domcontentloaded' });
  await page.getByText('投稿', { exact: true }).first().click();
  await page.getByText('テキスト', { exact: true }).first().click();
  await page.waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 15000 });
  process.stdout.write(`エディタを開きました（経由クリック）: ${page.url()}\n`);
}

async function uploadHeaderImage(page, imagePath) {
  process.stdout.write(`ヘッダー画像をアップロード: ${imagePath}\n`);

  // Step 1: 「画像を追加」ボタンをクリック → ドロップダウンメニューが開く
  const cameraBtn = page.locator('button[aria-label="画像を追加"]').first();
  await cameraBtn.waitFor({ state: 'visible', timeout: 15000 });
  await cameraBtn.click();
  process.stdout.write('  カメラボタン押下 → ドロップダウン表示\n');

  // Step 2: ドロップダウン内の「画像をアップロード」を選択。
  // この遷移でファイル選択ダイアログが開くか、隠し input がマウントされる。
  const uploadOption = page.locator('text=画像をアップロード').first();
  await uploadOption.waitFor({ state: 'visible', timeout: 5000 });

  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await uploadOption.click();
  const fileChooser = await fileChooserPromise;

  if (fileChooser) {
    process.stdout.write('  ファイル選択ダイアログ検出 → setFiles\n');
    await fileChooser.setFiles(imagePath);
  } else {
    process.stdout.write('  ダイアログ未検出 → input#note-editor-eyecatch-input にファイルセット\n');
    await page.locator('input#note-editor-eyecatch-input').setInputFiles(imagePath);
  }

  // アップロード完了を待ち、位置調整モーダルが出た場合は確定ボタンを押す
  await page.waitForTimeout(2500);
  const confirmBtn = await page
    .locator('button')
    .filter({ hasText: /^(保存|OK|決定|適用|完了)$/ })
    .first()
    .elementHandle({ timeout: 5000 })
    .catch(() => null);
  if (confirmBtn) {
    process.stdout.write('  画像位置調整モーダルを確定\n');
    await confirmBtn.click();
  }
  await page.waitForTimeout(1500);
}

async function fillTitle(page, title) {
  await page.fill('textarea[placeholder="記事タイトル"]', title);
  process.stdout.write(`タイトル入力: ${title}\n`);
}

async function fillBody(page, body, hashtags) {
  const editor = page.locator('div.ProseMirror[contenteditable="true"]');
  await editor.click();
  await page.waitForTimeout(300);

  // 末尾にハッシュタグ行を付け、先頭に改行を入れる。
  // note は paste 内容の先頭が「#」で始まるとコードブロックと誤判定するため、
  // 先頭に改行を 1 つ追加して回避する。
  const tagLine = hashtags.length > 0 ? '\n\n' + hashtags.map((t) => '#' + t).join(' ') : '';
  const content = '\n' + body + tagLine;

  // クリップボード経由でペースト → note の Markdown 自動変換が発火する
  await page.evaluate((text) => navigator.clipboard.writeText(text), content);
  await page.keyboard.press('Control+V');

  process.stdout.write(`本文ペースト完了（${content.length} 文字）\n`);
  await page.waitForTimeout(3000);
}

async function saveDraft(page) {
  process.stdout.write('下書き保存ボタンをクリック\n');
  await page.getByRole('button', { name: '下書き保存' }).click();
  // 保存完了を示す UI 変化を待つ。確実な指標がなければ固定時間待機。
  await page.waitForTimeout(3000);
  return page.url();
}
