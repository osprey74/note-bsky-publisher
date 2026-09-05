#!/usr/bin/env node
import { RichText } from '@atproto/api';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

const HELP = `\
Usage:
  note-bsky-count --text-file <path>
  note-bsky-count --text "<post body>"

Bluesky 投稿の grapheme 数（絵文字含む書記素）を実測します。
300 を超えた場合は exit code 1 を返します。

Options:
  --text, -t        本文（CLI 引数で直接渡す）
  --text-file, -f   本文をファイルから読み込む（推奨：日本語の引用符問題回避）
  --help, -h        このヘルプを表示

認証情報（.env）は不要です。
`;

main().catch((err) => {
  process.stderr.write(`エラー: ${err.stack ?? err.message ?? err}\n`);
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      text: { type: 'string', short: 't' },
      'text-file': { type: 'string', short: 'f' },
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

  const rt = new RichText({ text });
  const over = rt.graphemeLength > 300;
  process.stdout.write(`graphemeLength: ${rt.graphemeLength}/300${over ? ` (超過 +${rt.graphemeLength - 300})` : ''}\n`);

  if (over) {
    process.exitCode = 1;
  }
}
