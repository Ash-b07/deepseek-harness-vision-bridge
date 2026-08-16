#!/usr/bin/env bash
# vision-bridge · 一键安装到 dsh web profile(2.0)
#
# 做法:
#   1) 把 视觉插件/plugin 符号链接到 $HOME/.dsh/profiles/web/node_modules/vision-bridge
#      (profile 自己的 node_modules 优先于扁平回退目录,补丁用相对路径引用,零依赖不依赖裸名解析)
#   2) 对 rc.6 api-proxy 安装带签名校验、原始备份的最小 Host 补丁
#   3) 在 profile 的 cordis.patch.yml(用户补丁层)插入一行:
#        - insert:
#            - id: vision-bridge
#              name: 'vision-bridge'
#   4) 重启 dsh web 生效
#
# 卸载:删除符号链接 + 从 cordis.patch.yml 删除该 insert 块(或还原备份)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
HOST_PATCH_SCRIPT="$SCRIPT_DIR/host-patch.mjs"
PROFILE_DIR="$HOME/.dsh/profiles/web"
PROFILE_NM="$PROFILE_DIR/node_modules"
SHARED_NM="$PROFILE_DIR/../node_modules"
LINK_DIR="$PROFILE_NM/vision-bridge"
PATCH="$PROFILE_DIR/cordis.patch.yml"
STAMP="$(date +%s)"

echo "==> 1/4 建立插件符号链接"
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

echo "==> 2/4 安装 Host 图片准入与模型能力目录补丁"
HOST_TARGETS=(
  "$SHARED_NM/@deepseek-ai/dsh-host-apiproxy/lib/index.js"
  "$SHARED_NM/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js"
)
node "$HOST_PATCH_SCRIPT" --apply "${HOST_TARGETS[@]}"

echo "==> 3/4 更新 profile 补丁($PATCH)"
if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak.$STAMP"
  echo "    已备份原补丁 -> cordis.patch.yml.bak.$STAMP"
fi

INSERT_BLOCK=$'- insert:\n    - id: vision-bridge\n      name: \'vision-bridge\'\n'

if grep -q "vision-bridge" "$PATCH" 2>/dev/null; then
  # 1.x 使用文件路径加载，client-modules 无法把它识别为双端 package；迁移为裸包名。
  perl -0pi -e "s#name: './node_modules/vision-bridge/index\\.js[^']*'#name: 'vision-bridge'#g" "$PATCH"
  echo "    cordis.patch.yml 已包含 vision-bridge,已确认使用裸包名加载"
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

echo "==> 4/4 完成"
echo ""
echo "下一步:"
echo "  1. 重启 dsh web 使 Host 与 Client 插件生效"
echo "  2. 在输入框左侧打开「视觉增强」并选择一个多模态模型"
echo "  3. 主模型保持 DeepSeek,直接上传图片验证自动桥接"
echo ""
echo "Host 补丁回滚命令:"
echo "  node '$HOST_PATCH_SCRIPT' --revert '${HOST_TARGETS[0]}' '${HOST_TARGETS[1]}'"
