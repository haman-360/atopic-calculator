---
name: feedback_auto_commit_push
description: コード修正後、問題なければコミットとGitHubへのプッシュまで自動で完了させる
metadata:
  type: feedback
---

コード修正が完了して問題なければ、コミットメッセージ案の提示を省略してコミット＋`git push`まで自動で完了させる。

**Why:** ユーザーが「コミットお願いします」と毎回指示するのを省きたい。承認ステップなしで一気に終わらせる方が効率的。

**How to apply:** コードを編集・`clasp push`などが完了した後、特に問題がなければそのままコミット（conventional commits・日本語）＋`git push origin main`まで実行する。エラーや不確実な変更がある場合のみ確認を取る。
