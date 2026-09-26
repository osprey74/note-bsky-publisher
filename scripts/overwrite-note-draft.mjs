#!/usr/bin/env node
// 既存の note 下書き／予約投稿の本文を、ローカル Markdown で上書きする。
// publish-note.mjs が新規作成専用なのに対し、こちらは既存記事の編集画面を開いて差し替える。
// note の WYSIWYG は貼り付けられた Markdown を変換しないため、
// ローカルで HTML に変換し ClipboardItem の text/html で貼る。
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const STATE_PATH = 'auth/note-storage-state.json';

const HELP = `\
Usage:
  note-bsky-overwrite --file <markdown-path> --note-id <nXXXXXXXX> [options]
  note-bsky-overwrite --file <markdown-path> --new

Markdown を HTML に変換して note のエディタに貼り付けます。
note の WYSIWYG は貼り付けられた Markdown 記法を変換しないため、
プレーンテキストではなく ClipboardItem の text/html で渡します。

Options:
  --file, -f      投入する Markdown のパス（必須）
  --note-id, -n   上書き対象の note 記事 ID（例: n8b5568ea9711）
  --new           既存記事の上書きではなく、新規下書きとして作成する
  --dry           ブラウザを開かず、変換結果を <name>.preview.html に書き出す
  --inspect       何も書き換えず、対象記事の現状（本文長・画像数）だけを出力する
  --insert-images 目印段落（▼▼▼ 図解 N をここに挿入 ▼▼▼）を実画像に置き換える
  --only <n>      --insert-images で 1 点だけ処理する
  --from <n>      --insert-images で n 番目以降を処理する
  --clean-markers 残った目印段落を削除する
  --save          保存ボタンの自動クリックを試みる（既定: 押さない）
  --help, -h      ヘルプ

本文中の画像（![...](...)）は note 側でのアップロードが必要なため、
貼り付け時には目印の段落に置き換え、あとから --insert-images で実画像にします。

注意: note のエディタは「下書き保存」を押さなくても自動保存されます。
既存記事を上書きするモードでは、実行前に本文の画像枚数を表示するので、
意図しない記事を潰していないか確認してから進めてください。
`;

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', short: 'f' },
      'note-id': { type: 'string', short: 'n' },
      save: { type: 'boolean' },
      dry: { type: 'boolean' },
      inspect: { type: 'boolean' },
      'insert-images': { type: 'boolean' },
      only: { type: 'string' },
      from: { type: 'string' },
      'clean-markers': { type: 'boolean' },
      new: { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) { process.stdout.write(HELP); return; }
  // --note-id が要るのは既存記事を触るときだけ
  const needsId = !values.dry && !values.new;
  if (!values.file || (needsId && !values['note-id'])) {
    process.stderr.write('エラー: --file は必須です（--new / --dry 以外は --note-id も必要）\n\n' + HELP);
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(resolve(values.file), 'utf-8');
  const { meta, body: rawBody } = parseFrontmatter(raw);
  const cleaned = stripHtmlComments(rawBody);
  const { title, body } = extractTitle(cleaned);
  const { text: bodyNoImg, figures } = extractImages(body);
  const hashtags = (meta.hashtags ?? []).slice(0, 5);
  const headerImage = meta.header_image ? resolve(meta.header_image) : null;
  const html = mdToHtml(bodyNoImg)
    + (hashtags.length ? `\n<p>${hashtags.map((t) => '#' + t).join(' ')}</p>` : '');

  process.stdout.write('--- 差し替え内容 ---\n');
  process.stdout.write(`タイトル   : ${title}\n`);
  process.stdout.write(`本文       : ${bodyNoImg.length} 文字 → HTML ${html.length} 文字\n`);
  process.stdout.write(`図（除外）  : ${figures.length} 点\n`);
  figures.forEach((f, i) => process.stdout.write(`  [FIG${String(i + 1).padStart(2, '0')}] ${f}\n`));
  process.stdout.write('\n');

  if (values.dry) {
    const out = resolve(values.file).replace(/\.md$/, '.preview.html');
    await writeFile(out, html, 'utf-8');
    process.stdout.write(`変換結果を書き出しました: ${out}\n`);
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({
    storageState: STATE_PATH,
    locale: 'ja-JP',
    viewport: { width: 1400, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  // 新規記事として下書きを作る（既存記事の上書きではない）
  if (values.new) {
    await openNewEditor(page);
    if (headerImage) await tryHeaderImage(page, headerImage);
    await replaceTitle(page, title);
    await replaceBody(page, html);
    await insertImages(page, figures, resolve(values.file, '..', '..', '..'), null, null);
    await reportButtons(page);
    process.stdout.write('\n新規下書きを作成しました。');
    process.stdout.write('内容を確認して「下書き保存」を押してください。\n');
    process.stdout.write('30 分後に自動終了します（Ctrl+C で即終了）。\n');
    await page.waitForTimeout(30 * 60 * 1000);
    return;
  }

  await openExistingEditor(page, values['note-id']);
  await reportCurrentState(page);

  // 何も書き換えずに現状だけ見る（上書き前の安全確認用）
  if (values.inspect) {
    await reportButtons(page);
    await browser.close();
    return;
  }

  // 目印段落を実画像に置き換えるだけのモード（本文は触らない）
  if (values['clean-markers']) {
    await cleanMarkers(page);
    await page.waitForTimeout(30 * 60 * 1000);
    return;
  }

  if (values['insert-images']) {
    const only = values.only ? Number(values.only) : null;
    const from = values.from ? Number(values.from) : null;
    await insertImages(page, figures, resolve(values.file, '..', '..', '..'), only, from);
    await reportButtons(page);
    process.stdout.write('\n画像挿入が完了しました。ブラウザは開いたままです。30 分後に自動終了します。\n');
    await page.waitForTimeout(30 * 60 * 1000);
    return;
  }
  await replaceTitle(page, title);
  await replaceBody(page, html);
  await reportButtons(page);

  if (values.save) await trySave(page);

  process.stdout.write('\n本文の差し替えが完了しました。\n');
  process.stdout.write('ブラウザは開いたままです。内容を目視確認のうえ保存してください。\n');
  process.stdout.write('30 分後に自動終了します（Ctrl+C で即終了）。\n');
  await page.waitForTimeout(30 * 60 * 1000);
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
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    meta[kv[1]] = v.startsWith('[') && v.endsWith(']')
      ? v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : v.replace(/^["']|["']$/g, '');
  }
  return meta;
}

function stripHtmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (!m) return { title: '', body: body.trim() };
  return { title: m[1].trim(), body: body.replace(m[0], '').trim() };
}

// 画像行を取り除き、挿入位置が分かる目印段落に置き換える
function extractImages(body) {
  const figures = [];
  // alt は直後のキャプション行と内容が重複するため捨て、目印だけを残す
  const text = body.replace(/^!\[[^\]]*\]\(([^)]+)\)\s*$/gm, (_all, src) => {
    figures.push(src);
    // 直後のキャプション行と同じ段落に吸われないよう空行を足す
    return `▼▼▼ 図解 ${figures.length} をここに挿入（${src.split('/').pop()}）▼▼▼\n`;
  });
  return { text, figures };
}

// ---------- Markdown → HTML ----------

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// インライン記法。コードスパンを先に退避してから他の記法を適用する。
function inline(s) {
  const spans = [];
  let t = s.replace(/`([^`]+)`/g, (_a, code) => {
    spans.push(`<code>${esc(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_a, label, url) => `<a href="${url}">${label}</a>`);
  // <https://…> 形式の自動リンク（esc 済みなので &lt; &gt; を見る）
  t = t.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_a, url) => `<a href="${url}">${url}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_a, i) => spans[Number(i)]);
  return t;
}

function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // コードブロック
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 閉じ fence
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 区切り線
    if (/^(---+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 見出し（note は h2 / h3 のみ。h4 以下は h3 に寄せる）
    const h = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (h) {
      const tag = h[1].length === 2 ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
      i++; continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }

    // 箇条書き
    if (/^[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''));
      out.push(`<ul>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`);
      continue;
    }

    // 番号付き
    if (/^\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ''));
      out.push(`<ol>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ol>`);
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 段落（空行または別ブロックが来るまで）
    const buf = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^(```|>|[-*]\s|\d+\.\s|#{2,6}\s|---+\s*$)/.test(lines[i])
    ) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  // 本文冒頭の区切り線はタイトル直下の罫線になってしまうので落とす
  while (out[0] === '<hr>') out.shift();
  return out.join('\n');
}

// ---------- ブラウザ操作 ----------

async function openNewEditor(page) {
  for (const url of ['https://editor.note.com/new', 'https://note.com/notes/new']) {
    process.stdout.write(`新規エディタを試行: ${url}\n`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ok = await page
      .waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 10000 })
      .catch(() => null);
    if (ok) { process.stdout.write(`エディタを開きました: ${page.url()}\n`); return; }
  }
  throw new Error('新規エディタを開けませんでした。ログイン状態を確認してください。');
}

// ヘッダー画像は note の UI 変更で自動設定が通らないことがある。
// ここで失敗しても記事本文の投入は続けたいので、例外は握って警告だけ出す。
async function tryHeaderImage(page, imagePath) {
  process.stdout.write(`ヘッダー画像を試行: ${imagePath}\n`);
  try {
    const btn = page.locator('button[aria-label="画像を追加"]').first();
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();

    const opt = page.locator('text=画像をアップロード').first();
    await opt.waitFor({ state: 'visible', timeout: 5000 });
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await opt.click();
    const chooser = await chooserPromise;
    if (chooser) await chooser.setFiles(imagePath);
    else await page.locator('input#note-editor-eyecatch-input').setInputFiles(imagePath);

    await page.waitForTimeout(2500);
    const confirm = page.locator('button').filter({ hasText: /^(保存|OK|決定|適用|完了)$/ }).first();
    if (await confirm.count() > 0) await confirm.click();
    await page.waitForTimeout(1500);
    process.stdout.write('  ヘッダー画像を設定しました\n');
  } catch (err) {
    process.stdout.write(`  ヘッダー画像の自動設定に失敗しました（手動で設定してください）: ${err.message}\n`);
  }
}

async function openExistingEditor(page, noteId) {
  const candidates = [
    `https://editor.note.com/notes/${noteId}/edit`,
    `https://note.com/notes/${noteId}/edit`,
  ];
  for (const url of candidates) {
    process.stdout.write(`編集画面を試行: ${url}\n`);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const ok = await page
      .waitForSelector('div.ProseMirror[contenteditable="true"]', { timeout: 10000 })
      .catch(() => null);
    if (ok) { process.stdout.write(`編集画面を開きました: ${page.url()}\n`); return; }
  }
  throw new Error('編集画面を開けませんでした。ログイン状態（auth/note-storage-state.json）を確認してください。');
}

// 上書き前に現状を出力しておく（意図しない記事を潰さないための確認）
async function reportCurrentState(page) {
  const curTitle = await page.locator('textarea[placeholder="記事タイトル"]').inputValue().catch(() => '(取得不可)');
  const curLen = await page.locator('div.ProseMirror[contenteditable="true"]').innerText().then((t) => t.length).catch(() => -1);
  const imgCount = await page.locator('div.ProseMirror img').count().catch(() => -1);
  process.stdout.write('\n--- 上書き前の状態 ---\n');
  process.stdout.write(`現タイトル : ${curTitle}\n`);
  process.stdout.write(`現本文     : ${curLen} 文字\n`);
  process.stdout.write(`本文中の画像: ${imgCount} 点\n\n`);
  if (imgCount > 0) {
    process.stdout.write('※ 本文に画像があります。上書きすると消えるため、貼り直しが必要です。\n\n');
  }
}

async function replaceTitle(page, title) {
  const ta = page.locator('textarea[placeholder="記事タイトル"]');
  await ta.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await ta.fill(title);
  process.stdout.write(`タイトル差し替え: ${title}\n`);
}

async function replaceBody(page, html) {
  const editor = page.locator('div.ProseMirror[contenteditable="true"]');
  await editor.click();
  await page.waitForTimeout(300);

  // 既存本文を全消去
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);

  // text/html でクリップボードに載せて貼る（プレーン Markdown は note が変換しない）
  await page.evaluate(async (payload) => {
    const item = new ClipboardItem({
      'text/html': new Blob([payload], { type: 'text/html' }),
      'text/plain': new Blob([payload.replace(/<[^>]+>/g, '')], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, html);

  await editor.click();
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(4000);

  const after = await editor.innerText();
  const h2 = await page.locator('div.ProseMirror h2').count();
  const h3 = await page.locator('div.ProseMirror h3').count();
  const pre = await page.locator('div.ProseMirror pre').count();
  const ul = await page.locator('div.ProseMirror ul').count();
  process.stdout.write(`本文ペースト完了: ${after.length} 文字 / h2=${h2} h3=${h3} pre=${pre} ul=${ul}\n`);
}

// 「▼▼▼ 図解 N をここに挿入 ▼▼▼」の段落を選択して、実画像を貼り付けで置き換える。
// note のエディタは画像のクリップボード貼り付けを受け取ってアップロードしてくれる。
async function insertImages(page, figures, repoRoot, only, from) {
  for (let n = 1; n <= figures.length; n++) {
    if (only && n !== only) continue;
    if (from && n < from) continue;

    const marker = `図解 ${n} をここに挿入`;
    const para = page.locator('div.ProseMirror p', { hasText: marker }).first();
    if (await para.count() === 0) {
      process.stdout.write(`  [FIG${String(n).padStart(2, '0')}] 目印が見つかりません → スキップ\n`);
      continue;
    }

    const imgPath = resolve(repoRoot, figures[n - 1]);
    const bytes = await readFile(imgPath);

    // 目印の文字を先に消して空段落にしてから貼る。
    // 選択したまま画像を貼ると、note は選択を置換せず画像を足すだけで目印が残る。
    await para.scrollIntoViewIfNeeded();
    await para.click({ clickCount: 3 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }, bytes.toString('base64'));

    await page.keyboard.press('Control+V');
    await page.waitForTimeout(4000); // アップロード完了を待つ

    const imgs = await page.locator('div.ProseMirror img').count();
    const left = await page.locator('div.ProseMirror p', { hasText: marker }).count();
    process.stdout.write(
      `  [FIG${String(n).padStart(2, '0')}] ${figures[n - 1].split('/').pop()} → 画像 ${imgs} 点 / 目印残り ${left}\n`
    );
  }
}

// 画像を入れ終わったあとに残った目印段落を消す
async function cleanMarkers(page) {
  const sel = 'div.ProseMirror p';
  for (let guard = 0; guard < 30; guard++) {
    const para = page.locator(sel, { hasText: 'をここに挿入' }).first();
    if (await para.count() === 0) break;
    await para.scrollIntoViewIfNeeded();
    await para.click({ clickCount: 3 });
    await page.waitForTimeout(150);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace'); // 空段落ごと詰める
    await page.waitForTimeout(400);
  }
  const left = await page.locator(sel, { hasText: 'をここに挿入' }).count();
  const imgs = await page.locator('div.ProseMirror img').count();
  process.stdout.write(`目印の掃除完了: 残り ${left} / 画像 ${imgs} 点\n`);
}

// 予約投稿か下書きかでボタン名が変わるため、押す前に一覧を出す
async function reportButtons(page) {
  const names = await page.locator('button').allInnerTexts().catch(() => []);
  const visible = names.map((s) => s.trim()).filter(Boolean);
  process.stdout.write(`\n画面上のボタン: ${JSON.stringify(visible)}\n`);
}

async function trySave(page) {
  for (const name of ['下書き保存', '保存', '更新']) {
    const btn = page.getByRole('button', { name, exact: true }).first();
    if (await btn.count().then((c) => c > 0).catch(() => false)) {
      process.stdout.write(`「${name}」をクリックします\n`);
      await btn.click();
      await page.waitForTimeout(3000);
      return;
    }
  }
  process.stdout.write('保存ボタンを特定できませんでした。手動で保存してください。\n');
}
