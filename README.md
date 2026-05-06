# note-bsky-publisher

Markdown 記事を [note](https://note.com) に下書き保存し、[Bluesky](https://bsky.app) に告知文を投稿する CLI ツールです。

- **note**：公式 API がないため、Playwright で半自動化（ログインセッション保存 → 下書き保存）
- **Bluesky**：公式 [AT Protocol](https://atproto.com/) を使った自動投稿（OGP リンクカード対応）

## このツールが向いているケース

- Markdown で記事を書いて、note と Bluesky 両方に展開している個人開発者・ブロガー
- Note の WYSIWYG エディタにタイトル・本文・ヘッダー画像・ハッシュタグを毎回手入力するのが手間な人
- Bluesky 告知投稿にリンクカードを綺麗に出したい人
- Claude Code などのエージェントから記事公開フローを呼び出したい人

## 安全設計

- **note 側は「下書き保存」までの自動化**。誤公開を防ぐため、最終的な公開ボタンは人間が押す運用を前提にしています
- 認証情報（Bluesky App Password / note ログインセッション）は `.env` と `auth/` で**ローカル管理**、`.gitignore` で除外済み
- メインアカウントのパスワードは使わず、Bluesky の **App Password** を使ってください

---

## インストール

```bash
npm install -g github:osprey74/note-bsky-publisher

# 初回のみ：Playwright が使う Chromium を取得
npx playwright install chromium
```

> Node.js 20 以降が必要です。

---

## セットアップ

### 1. Bluesky の App Password を発行

1. Bluesky 設定 → Privacy and Security → **App Passwords**
2. 新規発行（メインのパスワードは使わないこと）

### 2. `.env` を作成

ツールは **CWD（カレントディレクトリ）の `.env`** を読みます。記事を管理しているフォルダで以下を作成してください：

```bash
cp .env.example .env
```

中身：

```
BSKY_HANDLE=your-handle.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

### 3. note のログインセッションを保存

```bash
note-bsky-login
```

ブラウザが起動して note のログイン画面が開きます。手動でログインを完了したら、ターミナルで Enter を押してください。`auth/note-storage-state.json` にセッションが保存され、以降の note 操作はこのセッションを使います。

> セッションは note 側の Cookie 有効期限で失効します。失効したら同じコマンドで再保存してください。

---

## 使い方

### Bluesky に告知投稿（OGP リンクカード付き）

```bash
note-bsky-announce \
  --text-file path/to/announcement.txt \
  --url "https://note.com/yourname/n/xxxxx"
```

- `--text` でテキストを直接渡すこともできます（CLI のクオート問題があるので `--text-file` 推奨）
- `--url` を指定すると、その URL の OGP（タイトル / 説明 / サムネイル）を自動取得してリンクカードを構築
- `--image` で別の画像を添付（指定すると `--url` の OGP より優先）
- `--dry-run` で投稿せず内容だけ確認

リッチテキストの facets（クリッカブルな URL・ハッシュタグ）は自動検出されます。

### note に下書き保存

```bash
note-bsky-post --file path/to/article.md
```

Markdown ファイルの YAML フロントマターから設定を読みます：

```yaml
---
header_image: path/to/header.png
hashtags: [Tag1, Tag2, Tag3]
---

# 記事タイトル

ここから本文 ...
```

| フロントマター | 用途 |
|---|---|
| `header_image` | 記事のヘッダー画像（CWD 相対パス） |
| `hashtags` | note のハッシュタグ（最大 5 個） |

タイトルは Markdown 内の最初の `# Heading` から自動抽出します。

`--keep-open` を付けると完了後もブラウザを閉じず、結果を目視確認できます。

### note エディタの DOM 構造を観察（高度）

```bash
note-bsky-explore
```

note のエディタ画面を開いた状態で待機します。DevTools で構造を確認した後、ターミナルで Enter を押すとページの DOM 情報とスクリーンショットを `auth/` に保存します。note の UI 変更でセレクタが壊れた場合のデバッグ用です。

---

## note の Markdown 自動変換について

note のエディタ（ProseMirror ベース）は、**ペースト時に Markdown 記法を自動変換**します。本ツールはクリップボード経由で本文を一括ペーストするため、以下が自動で反映されます：

- `## 見出し` / `### 小見出し`
- `**太字**`
- `[リンクテキスト](https://...)`
- `- 箇条書き` / `1. 番号付き`
- ``` ```language ``` ``` のコードブロック

### 既知の制約

- **ペーストする本文の先頭が `#` で始まると、note 側がコードブロックと誤判定します**。本ツールは先頭に空行を 1 つ追加して回避しています
- 一部のインライン記法（特殊な引用構文など）は変換されないため、生の記号が残ることがあります
- note の UI が更新されるとセレクタが壊れる可能性があります。その場合は `note-bsky-explore` で再観察してから Issue を立ててください

---

## ライセンス

[MIT](LICENSE)

## 著者

[osprey74](https://github.com/osprey74)
