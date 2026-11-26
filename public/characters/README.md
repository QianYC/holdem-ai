# 角色美术目录

每个 AI 角色一个子目录，目录名就是 `config.json` 里该角色的 `key`：

```
public/characters/
  opus/
    portrait.png      立绘（座位头像、结算卡）——png / webp / jpg / gif 均可
    win.png           胜利姿势（你被她淘汰、她夺冠时显示）
    lose.png          战败姿势（你淘汰她、你赢下整桌时显示）
    stickers/
      smug.png        表情包，文件名（不含扩展名）就是表情 id
      哭哭.png         中文文件名也可以
```

- 全部可选：缺哪张就退回 emoji（`avatar`）或不显示。
- 表情的中文名 / emoji 标签写在 `config.json` 的 `stickers` 里（`{"smug": {"label": "得意", "emoji": "😏"}}`），没写就直接用文件名。AI 会看到可用的表情 id，自己决定发不发。
- 也可以在角色配置里用 `portrait` / `winPortrait` / `losePortrait` 指定任意 `public/` 下的路径。
- `npm run art` 会按配置自动准备：`art.source` 下载立绘、`art.prompt`（+ `art.reference`）用图像模型生成立绘，然后按 `art.win` / `art.lose` 和 `stickers.*.prompt` 生成姿势和表情。

仓库自带默认 6 个角色的美术（来源见 [CREDITS.md](CREDITS.md)）。新角色的图片可以在网页「⚙ 设置 → AI 角色」里上传或一键生成。使用别人的二创作品时请遵守原作者的授权。
