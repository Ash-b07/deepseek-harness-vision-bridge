#!/usr/bin/env bash
# vision-bridge · 一键挂载到 dsh web profile(自用 1.0)
#
# 做法:
#   1) 把 视觉插件/plugin 符号链接到 $HOME/.dsh/profiles/web/node_modules/vision-bridge
#      (profile 自己的 node_modules 优先于扁平回退目录,补丁用相对路径引用,零依赖不依赖裸名解析)
#   2) 在 profile 的 cordis.patch.yml(用户补丁层)插入一行:
#        - insert:
#            - id: vision-bridge
#              name: './node_modules/vision-bridge/index.js'
#   3) 重启 dsh web 生效
#
# 卸载:删除符号链接 + 从 cordis.patch.yml 删除该 insert 块(或还原备份)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
PROFILE_DIR="$HOME/.dsh/profiles/web"
PROFILE_NM="$PROFILE_DIR/node_modules"
LINK_DIR="$PROFILE_NM/vision-bridge"
PATCH="$PROFILE_DIR/cordis.patch.yml"
STAMP="$(date +%s)"

echo "==> 1/3 建立插件符号链接"
if [ ! -d "$PROFILE_DIR" ]; then
  echo "[错误] 未找到 profile:$PROFILE_DIR(请确认 dsh web 已初始化,或改 PROFILE_DIR)"
  exit 1
fi
mkdir -p "$PROFILE_NM"
if [ -L "$LINK_DIR" ]; then
  echo "    已存在:$LINK_DIR -> $(readlink "$LINK_DIR")"
elif [ -e "$LINK_DIR" ]; then
  echo "[错误] $LINK_DIR 已存在但不是符号链接,请手动处理"
  exit 1
else
  ln -s "$PLUGIN_DIR" "$LINK_DIR"
  echo "    已链接 $PLUGIN_DIR -> $LINK_DIR"
fi

echo "==> 2/3 更新 profile 补丁($PATCH)"
if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak.$STAMP"
  echo "    已备份原补丁 -> cordis.patch.yml.bak.$STAMP"
fi

INSERT_BLOCK=$'- insert:\n    - id: vision-bridge\n      name: \'./node_modules/vision-bridge/index.js\'\n'

if grep -q "vision-bridge" "$PATCH" 2>/dev/null; then
  echo "    cordis.patch.yml 已包含 vision-bridge,跳过写入"
else
  # 判断是否默认空补丁(注释 + []):是则整体重写为受管版本,否则追加(保留用户已有内容)
  BODY="$(grep -vE '^\s*(#.*)?$' "$PATCH" 2>/dev/null | tr -d ' \t\r\n' || true)"
  if [ "$BODY" = "[]" ] || [ -z "$BODY" ]; then
    printf '%s\n' \
      "# dsh profile user patch layer —— managed by 视觉插件/install-plugin.sh" \
      "# (backup: cordis.patch.yml.bak.*)" \
      "" \
      "$INSERT_BLOCK" > "$PATCH"
    echo "    已写入受管补丁(原为默认空补丁)"
  else
    printf '%s' "$INSERT_BLOCK" >> "$PATCH"
    echo "    已追加 vision-bridge insert 块(保留了原有补丁内容)"
  fi
fi

echo "==> 3/3 完成"
echo ""
echo "下一步:"
echo "  1. 配置视觉模型路由(默认 opencode / mimo-v2.5-free,即 settings.yaml 的 llm-pi-ai 下已配置的模型):"
echo "     可选:复制 config.local.json.example 为 config.local.json 修改 visionProvider / visionModel"
echo "  2. 确保该模型在 settings.yaml 里声明了 input: [text, image](若模型确实支持图片;否则桥接会给出可操作报错)"
echo "  3. 重启 dsh web 使插件生效"
echo "  4. 验证:在 DeepSeek 会话里让模型 read_image 一张图片,应返回带 <type>vision-bridged</type> 的图片描述;"
echo "     或让模型直接调用 vision_bridge 工具(mode=ocr/describe/vqa)"
