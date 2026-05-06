#!/usr/bin/env node
import { AtpAgent, RichText } from '@atproto/api';
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const HELP = `\
Usage:
  note-bsky-announce --text-file <path> [--url <url>] [--image <path>] [--dry-run]
  note-bsky-announce --text "<post body>" [--url <url>] [--image <path>] [--dry-run]

Options:
  --text, -t        投稿本文（CLI 引数で直接渡す）
  --text-file, -f   投稿本文をファイルから読み込む（推奨：日本語の引用符問題回避）
  --url, -u         Note 記事 URL。指定すると OGP リンクカードを添付
  --image, -i       画像パス。指定すると画像を添付（--url の OGP より優先）
  --dry-run         投稿せず、送信予定の record を表示して終了
  --help, -h        このヘルプを表示

環境変数（.env / CWD 相対で読み込み）:
  BSKY_HANDLE         Bluesky ハンドル（例: yourname.bsky.social）
  BSKY_APP_PASSWORD   App Password（メインパスワードは使わない）
`;

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
}).finally(closeKeepalive);

async function main() {
  const { values } = parseArgs({
    options: {
      text: { type: 'string', short: 't' },
      'text-file': { type: 'string', short: 'f' },
      url: { type: 'string', short: 'u' },
      image: { type: 'string', short: 'i' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  let text;
  if (values['text-file']) {
    text = (await readFile(values['text-file'], 'utf-8')).trim();
  } else if (values.text) {
    text = values.text.trim();
  }
  if (!text) {
    process.stderr.write('エラー: --text または --text-file を指定してください。\n\n');
    process.stderr.write(HELP);
    process.exitCode = 1;
    return;
  }

  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!handle || !password) {
    process.stderr.write('エラー: .env に BSKY_HANDLE と BSKY_APP_PASSWORD を設定してください。\n');
    process.exitCode = 1;
    return;
  }

  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: handle, password });

  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  if (rt.graphemeLength > 300) {
    process.stderr.write(`エラー: 投稿が 300 文字を超えています（現在 ${rt.graphemeLength} 文字）。\n`);
    process.exitCode = 1;
    return;
  }

  let embed;
  if (values.image) {
    embed = await buildImageEmbed(agent, values.image);
  } else if (values.url) {
    embed = await buildExternalEmbed(agent, values.url);
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
    ...(embed ? { embed } : {}),
  };

  if (values['dry-run']) {
    process.stdout.write('--- DRY RUN ---\n');
    process.stdout.write(`graphemeLength: ${rt.graphemeLength}/300\n`);
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    return;
  }

  const result = await agent.post(record);
  const postId = result.uri.split('/').pop();
  process.stdout.write(`投稿しました: https://bsky.app/profile/${handle}/post/${postId}\n`);
}

// ---------- helpers ----------

async function buildImageEmbed(agent, imagePath) {
  const data = await readFile(imagePath);
  const upload = await agent.uploadBlob(data, { encoding: detectMime(imagePath) });
  return {
    $type: 'app.bsky.embed.images',
    images: [{ image: upload.data.blob, alt: basename(imagePath, extname(imagePath)) }],
  };
}

async function buildExternalEmbed(agent, url) {
  const html = await fetch(url).then((r) => r.text());
  const og = parseOG(html);
  const external = {
    uri: url,
    title: og.title ?? '',
    description: og.description ?? '',
  };
  if (og.image) {
    try {
      const res = await fetch(og.image);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') ?? 'image/jpeg';
      const upload = await agent.uploadBlob(buf, { encoding: ct });
      external.thumb = upload.data.blob;
    } catch (e) {
      process.stderr.write(`警告: OGP 画像の取得に失敗しました（投稿は続行）: ${e.message}\n`);
    }
  }
  return { $type: 'app.bsky.embed.external', external };
}

function parseOG(html) {
  const pick = (prop) => {
    const a = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'));
    if (a) return decodeEntities(a[1]);
    const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
    return b ? decodeEntities(b[1]) : undefined;
  };
  return { title: pick('og:title'), description: pick('og:description'), image: pick('og:image') };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function detectMime(path) {
  const ext = extname(path).toLowerCase().slice(1);
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] ??
    'application/octet-stream'
  );
}

// Node 内蔵 undici の keepalive ソケットを明示クローズ。
// Windows で process.exit() が libuv の async ハンドル整理と競合してアサーションを起こす問題の回避。
async function closeKeepalive() {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher && typeof dispatcher.close === 'function') {
    try { await dispatcher.close(); } catch { /* noop */ }
  }
}
