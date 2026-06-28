# 赤沼さん開発（Web アプリ）

エンジニアと共同で開発する Web アプリのリポジトリです。

## 概要

- 技術スタック: **未定（相談して決定）**
- 公開範囲: Private

## 開発の進め方（共同開発ルール）

このリポジトリは `main` を保護し、作業は必ずブランチを切って Pull Request 経由でマージします。

1. 最新を取得する
   ```bash
   git switch main
   git pull
   ```
2. 作業用ブランチを切る（例: `feat/login-form`, `fix/header-bug`）
   ```bash
   git switch -c feat/your-task
   ```
3. コミットして push する
   ```bash
   git add -A
   git commit -m "feat: 何をしたか"
   git push -u origin feat/your-task
   ```
4. GitHub で Pull Request を作成し、相手にレビューを依頼する
5. レビュー承認後に `main` へマージ

### ブランチ命名

| 種類 | プレフィックス | 例 |
| --- | --- | --- |
| 機能追加 | `feat/` | `feat/user-auth` |
| バグ修正 | `fix/` | `fix/login-error` |
| リファクタ | `refactor/` | `refactor/api-client` |
| ドキュメント | `docs/` | `docs/readme` |

### コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) に従います。

```
feat: ログインフォームを追加
fix: ヘッダーの表示崩れを修正
docs: README に開発手順を追記
```

## セットアップ

技術スタック決定後にここへ記載します。
