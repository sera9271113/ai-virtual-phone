"use client";

import { useState, useEffect, type CSSProperties, type MouseEvent } from "react";
import {
  ChevronLeft,
  SquareChevronRight,
  UserRound,
  QrCode,
  PaintbrushVertical,
  X,
} from "lucide-react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { loadCharacters, updateCharacter } from "@/lib/character-storage";
import { getStoryArchiveStats } from "@/lib/story-storage";
import { kvGet, kvSet } from "@/lib/kv-db";

type StoryCharacterSelectProps = {
  onSelect: (characterId: string) => void;
  onClose: () => void;
};

/* ════════════════════════════════════════════════════════════════
   这一版把布局从「CSS Grid + <style jsx global> + clamp/vw」
   全部换成了「纯内联样式（style={{...}}）+ Flexbox」。

   原因：导入到真机 App 里之后卡片粘连、网格布局失效、装饰顺序错乱——
   这些现象的根本原因几乎可以肯定是宿主容器（很多国内 App 的内嵌
   Web/Hybrid 容器、或自定义 CSS 解析器）不完整支持 CSS Grid /
   aspect-ratio / clamp() / <style> 标签里的全局样式表，只能可靠地
   识别标准的行内 style 属性和最基础的 flex 布局。

   所以这版彻底不依赖外部 <style> 表：所有布局、间距、颜色都写成
   内联样式对象，宽度用固定 px 代替 vw/clamp，头像比例用
   "padding-top 百分比撑高度" 的经典技巧代替 aspect-ratio，
   这样即使在功能有限的容器里也能正常渲染出两栏卡片。
   ════════════════════════════════════════════════════════════════ */

const FONT_SERIF = "'Cormorant Garamond', Georgia, serif";
const FONT_SC = "'Noto Sans SC', sans-serif";
// 与剧情界面 story.css 里 .story-app-shell 的字体栈完全一致，
// 两个界面的 STORY 顶栏（以及所有继承 shell 字体的文字）不再各用各的字体，
// 避免因字体不同导致的行高/基线差异，看起来"一高一低"。
const FONT_SANS = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT_SIGNATURE = "'Dancing Script', cursive";
const FONT_KINGHWA = "'KingHwaOldSong', 'Noto Sans SC', sans-serif";

const CSS_ACTIVE_KEY = "story_char_select_custom_css_v1";

/* 示例 CSS：对应下方选角卡片的默认外观，可复制修改后填入编辑框。
   注意：卡片本身用的是内联样式（style={{...}}），内联样式的优先级高于
   普通 CSS 类选择器，所以这里的覆盖规则都带 !important，否则不会生效。 */
const CSS_EXAMPLE = `/* 覆盖内联样式需要加 !important，否则不会生效 */
/* 下面按「页面结构」从外到内列出了几乎所有可自定义的元素，
   可以整段复制后按需增删、修改颜色/字号/边框/圆角等 */

/* ── 整体外壳 / 顶部导航栏 ───────────────────────── */
.ccs-shell {
  background: #fcfcfc !important;
}

.ccs-header {
  /* 与剧情界面顶栏是同一条顶栏，背景色/结构保持一致 */
  background: #fdfdfd !important;
}

.ccs-header-safe-area {
  /* 顶部状态栏占位区域，一般不用改高度，仅演示可覆盖背景 */
  background: transparent !important;
}

.ccs-header-content {
  background: transparent !important;
}

.ccs-header-left {
  /* 左区，包裹返回按钮，一般不用改 */
}

.ccs-header-right {
  /* 右区，包裹右侧按钮（选角界面只有一个「自定义CSS」按钮；剧情界面
     在这同一个右区里还并排放了「归档」「侧栏」两个按钮），一般不用改 */
}

.ccs-back-btn,
.ccs-css-btn {
  /* 实际默认是透明的（这两个按钮走 bareBtn 样式，下面还有一段内联 <style>
     用 !important 把 background 强制锁成 transparent）；这里的自定义规则
     写在更靠后的 <style> 标签里，同样是 !important，所以依旧能生效覆盖 */
  background: transparent !important;
  color: #333333 !important;
}

.ccs-header-title {
  /* 绝对定位居中于整条顶栏（不随左右按钮数量变化），仅可覆盖颜色 */
  color: #222222 !important;
}

/* ── 空状态（还没有角色卡时） ───────────────────── */
.ccs-empty {
  color: #888888 !important;
}

.ccs-empty-icon {
  color: #888888 !important;
}

.ccs-empty-text {
  color: #888888 !important;
}

/* ── 滚动区 / 单张卡片外层容器 ───────────────────── */
.ccs-scroll {
  background: transparent !important;
}

.ccs-slide {
  /* 卡片与卡片之间的外层包裹，一般用来改 margin */
}

/* ── 角色卡片主体 ─────────────────────────────────── */
.ccs-card {
  background: #ffffff !important;
  border: 1px solid #ececec !important;
  border-radius: 8px !important;
  box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.06) !important;
  color: #222222 !important;
}

.ccs-vert-divider {
  /* 顶到卡片上下边缘的纵向虚线装饰，位于渐变条右侧、NO 左侧（偏向 NO 一侧），
     与底部 NO 上方那条虚线同色同粗细，仅可覆盖颜色/粗细 */
  border-left: 1px dashed #eaeaea !important;
}

.ccs-top-row {
  /* 头像列 + 信息列 所在的行，一般不用改 */
}

/* — 左侧头像列 — */
.ccs-left-col {
}

.ccs-left-deco {
}

.ccs-left-deco-bar {
  background: #d8d8d8 !important;
}

.ccs-left-deco-arrows {
  color: #cccccc !important;
}

.ccs-avatar-box {
  border: 1px solid #d4d4d4 !important;
  background: #fafafa !important;
}

.ccs-avatar-inner {
}

.ccs-avatar-img {
  background: #eeeeee !important;
}

.ccs-avatar-fallback {
  background: #eeeeee !important;
  color: #bbbbbb !important;
}

.ccs-tag {
  /* 字体已锁定为 KingHwaOldSong（头像左下角名字标签），这里仅可覆盖颜色/背景/边框 */
  background: #ebebeb !important;
  color: #555555 !important;
  border-color: #ffffff !important;
}

/* — 右侧 ID CARD 信息列 — */
.ccs-right-col {
}

.ccs-right-deco {
  /* 与左侧三角箭头装饰同一水平线的三个小圆点 */
}

.ccs-right-deco-dot {
  background: #d8d8d8 !important;
}

.ccs-title {
  color: #111111 !important;
}

.ccs-title-divider {
  background: linear-gradient(to right, #b0b0b0, rgba(176, 176, 176, 0)) !important;
}

.ccs-info-list {
}

.ccs-info-row,
.ccs-info-field {
  /* Name / Gender / Archives / Round 四行，每行独占一行，同样的行间距 */
}

.ccs-label-auto {
  /* 固定宽度列，决定了四行 Name / Gender / Archives / Round 数值的左对齐起始位置 */
}

.ccs-label-en {
  /* 字体已锁定为 ID CARD 同款衬线斜体，这里仅可覆盖颜色 */
  color: #777777 !important;
}

.ccs-label-cn {
  /* 字体已锁定为 KingHwaOldSong（中文小标签 [姓名][性别][归档][轮数]），这里仅可覆盖颜色 */
  color: #aaaaaa !important;
}

.ccs-value {
  /* 字体已锁定为 KingHwaOldSong（姓名/性别变量），这里仅可覆盖颜色 */
  color: #333333 !important;
}

/* 姓名那一格额外叠加的高亮样式（字号更大、颜色更深） */
.ccs-value-highlight {
  color: #111111 !important;
}

.ccs-value-editable {
  /* 可点击编辑的「性别」字段，悬停时可加下划线之类的提示 */
}

.ccs-value-input {
  /* 字体已锁定为 KingHwaOldSong（性别编辑输入框），这里仅可覆盖颜色/下划线 */
  color: #333333 !important;
  border-bottom: 1px solid #999999 !important;
}

.ccs-round {
  color: #888888 !important;
}

/* Archives 数字，字体锁定为手写体（不倾斜），这里仅可覆盖颜色。
   与 .ccs-round 共用同一份基础样式（signatureText），默认颜色相同 */
.ccs-archive {
  color: #888888 !important;
}

/* — 卡片底部条 — */
.ccs-bottom-area {
  border-top: 1px dashed #eaeaea !important;
}

.ccs-bottom-left {
}

.ccs-id-label {
  /* 字体已锁定为 ID CARD 同款衬线体（非斜体），这里仅可覆盖颜色。默认与二维码/ID变量/NO/右箭头统一为中灰 */
  color: #888888 !important;
}

.ccs-id-value {
  /* 字体已锁定为 ID CARD 同款衬线体（非斜体），这里仅可覆盖颜色。默认与二维码/ID标签/NO/右箭头统一为中灰 */
  color: #888888 !important;
}

.ccs-bottom-right {
}

.ccs-badge {
  /* 字体已锁定为 ID CARD 同款衬线体（非斜体），这里仅可覆盖颜色。默认与二维码/ID/右箭头统一为中灰 */
  color: #888888 !important;
}

.ccs-qr-deco {
  /* 与ID/ID变量/NO/右箭头统一为中灰，且与右箭头图标同尺寸、居中对齐 */
  color: #888888 !important;
}

.ccs-enter {
  /* 右下角进入图标（square-chevron-right），已去掉外层容器，直接是图标本身；与二维码图标同尺寸、居中对齐，颜色统一中灰 */
  color: #888888 !important;
}

/* ── 自定义 CSS 编辑弹窗 ──────────────────────────── */
.ccs-modal-overlay {
  /* 已改为无遮罩（背景透明，点击空白处仍可关闭弹窗），这里仅演示如果想要
     遮罩可以自己加回来 */
  background: transparent !important;
}

.ccs-modal-panel {
  background: #ffffff !important;
  border-radius: 16px 16px 0 0 !important;
}

.ccs-modal-header {
}

.ccs-modal-title {
  color: #222222 !important;
}

.ccs-modal-close-btn {
  background: rgba(0, 0, 0, 0.05) !important;
  color: #333333 !important;
}

.ccs-modal-body {
}

.ccs-modal-textarea {
  color: #333333 !important;
  background: #fafafa !important;
  border: 1px solid #e3e3e3 !important;
  border-radius: 8px !important;
}

.ccs-modal-footer {
}

.ccs-modal-icon-btn {
  background: #fafafa !important;
  border: 1px solid #e3e3e3 !important;
  color: #333333 !important;
  border-radius: 10px !important;
}

/* 「保存」按钮，在 .ccs-modal-icon-btn 基础上叠加深色主题 */
.ccs-modal-icon-btn-primary {
  background: #222222 !important;
  color: #ffffff !important;
  border: 1px solid #222222 !important;
}

/* ── 预设列表弹窗 ─────────────────────────────────── */
.ccs-sub-overlay {
  /* 同样已改为无遮罩，仅演示 */
  background: transparent !important;
}

.ccs-sub-panel {
  background: #ffffff !important;
  border-radius: 14px !important;
}

.ccs-sub-header {
  border-bottom: 1px solid #ececec !important;
}

.ccs-sub-title {
  color: #222222 !important;
}

.ccs-sub-scroll {
}

.ccs-preset-add-row {
  border-bottom: 1px solid #ececec !important;
}

.ccs-preset-add-input {
  color: #333333 !important;
  background: #fafafa !important;
  border: 1px solid #e3e3e3 !important;
  border-radius: 8px !important;
}

.ccs-preset-add-btn {
  background: #fafafa !important;
  border: 1px solid #e3e3e3 !important;
  color: #333333 !important;
  border-radius: 8px !important;
}

.ccs-preset-empty {
  color: #999999 !important;
}

.ccs-preset-item {
  border-bottom: 1px solid #f0f0f0 !important;
}

.ccs-preset-item-info {
  /* 预设条目里可点击加载的那一块（名称+时间），一般不用改 */
}

.ccs-preset-item-name {
  color: #222222 !important;
}

.ccs-preset-item-date {
  color: #999999 !important;
}

.ccs-preset-delete-btn {
  color: #c04b4b !important;
}`;

const styles: Record<string, CSSProperties> = {
  shell: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    background: "#fcfcfc",
    fontFamily: FONT_SANS,
  },
  /* 顶栏结构/数值与剧情界面（story.css 里的 .story-header 系列）保持完全一致：
     左区 / 绝对居中的标题 / 右区（可容纳多个并排按钮）。选角界面顶栏只是
     右区按钮更少而已——本质是同一个顶栏，不是另外做的一套。 */
  header: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    zIndex: 12,
    flexShrink: 0,
    background: "var(--c-story-bg-top, #fdfdfd)",
  },
  headerSafeArea: {
    height: "var(--page-header-safe-top, 48px)",
    flexShrink: 0,
    pointerEvents: "none",
  },
  headerContent: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: "var(--page-header-content-height, 42px)",
    padding: "1px 20px",
  },
  headerLeft: {
    display: "flex",
    justifyContent: "flex-start",
    position: "relative",
    zIndex: 1,
  },
  headerRight: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    position: "relative",
    zIndex: 1,
  },
  bareBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    padding: 6,
    boxSizing: "border-box",
    border: "none",
    borderRadius: 0,
    background: "transparent",
    boxShadow: "none",
    color: "var(--c-story-accent, #333333)",
    appearance: "none",
    WebkitAppearance: "none",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
    transition: "opacity 0.2s ease",
  } as CSSProperties,
  /* 标题绝对居中于整条顶栏（而不是靠 flex:1 撑开居中），这样无论左右两侧
     按钮数量是否对称（剧情界面右侧比选角界面多两个按钮），STORY 字样都
     始终精确居中，两个界面视觉上是同一条顶栏 */
  headerCenter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "50%",
    transform: "translateY(-50%)",
    textAlign: "center",
    fontSize: "calc(15px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "var(--c-story-heading, #222222)",
    letterSpacing: 0.5,
    pointerEvents: "none",
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    overflowX: "hidden",
    WebkitOverflowScrolling: "touch",
    display: "flex",
    flexDirection: "column",
    padding: "18px 20px 24px",
  },
  empty: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    gap: 10,
    color: "#888",
    textAlign: "center",
    padding: "0 32px",
  },
  slide: {
    marginBottom: 18,
  },
  card: {
    position: "relative",
    width: "100%",
    background: "#ffffff",
    boxShadow: "0 6px 14px -4px rgba(0, 0, 0, 0.06)",
    border: "1px solid #ececec",
    borderRadius: 8,
    padding: 12,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    color: "#222222",
    overflow: "hidden",
  },
  vertDivider: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 68,
    width: 0,
    borderLeft: "1px dashed #eaeaea",
    zIndex: 0,
    pointerEvents: "none",
  },
  topRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "stretch",
    gap: 10,
  },
  leftCol: {
    width: 106,
    flexShrink: 0,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    zIndex: 1,
  },
  leftDeco: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 5,
    marginBottom: 8,
    height: 16,
  },
  leftDecoBar: {
    width: 18,
    height: 2.5,
    background: "#d8d8d8",
    flexShrink: 0,
  },
  leftDecoArrows: {
    fontSize: "calc(10px*var(--app-text-scale,1))",
    fontWeight: 700,
    color: "#cccccc",
    letterSpacing: 1.5,
    lineHeight: "16px",
    display: "inline-block",
  },
  avatarBox: {
    position: "relative",
    width: "100%",
    /* 用 paddingTop 百分比撑出固定比例的高度，兼容不支持 aspect-ratio 的容器 */
    paddingTop: "122%",
    border: "1px solid #d4d4d4",
    boxSizing: "border-box",
    background: "#fafafa",
  },
  avatarInner: {
    position: "absolute",
    top: 3,
    left: 3,
    right: 3,
    bottom: 3,
    overflow: "hidden",
  },
  avatar: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    background: "#eeeeee",
  },
  avatarFallback: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: FONT_SERIF,
    fontStyle: "italic",
    fontSize: "calc(20px*var(--app-text-scale,1))",
    color: "#bbbbbb",
    background: "#eeeeee",
  },
  tagLeft: {
    position: "absolute",
    bottom: -4,
    left: -6,
    background: "#ebebeb",
    padding: "1px 5px",
    fontFamily: FONT_KINGHWA,
    fontSize: "calc(7px*var(--app-text-scale,1))",
    fontWeight: "normal",
    color: "#555555",
    letterSpacing: 0.3,
    border: "1.5px solid #ffffff",
    maxWidth: "calc(100% + 6px)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    zIndex: 2,
  },
  rightCol: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    zIndex: 1,
  },
  rightDeco: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 5,
    marginBottom: 8,
    height: 16,
  },
  rightDecoDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "#d8d8d8",
    flexShrink: 0,
  },
  mainTitle: {
    fontFamily: FONT_SERIF,
    fontStyle: "italic",
    fontSize: "calc(20px*var(--app-text-scale,1))",
    fontWeight: 600,
    letterSpacing: 0.5,
    color: "#111111",
    lineHeight: 1,
    whiteSpace: "nowrap",
  },
  titleDivider: {
    marginTop: 5,
    height: 3,
    width: 160,
    background: "linear-gradient(to right, #b0b0b0, rgba(176, 176, 176, 0))",
  },
  infoList: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    gap: 4,
    flex: 1,
    marginTop: 6,
    minWidth: 0,
  },
  infoRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: 14,
    minWidth: 0,
  },
  labelAuto: {
    flexShrink: 0,
    width: 82,
    display: "flex",
    alignItems: "baseline",
    gap: 3,
  },
  labelEn: {
    fontFamily: FONT_SERIF,
    fontStyle: "italic",
    fontSize: "calc(11px*var(--app-text-scale,1))",
    fontWeight: 500,
    color: "#777777",
    whiteSpace: "nowrap",
  },
  labelCn: {
    fontFamily: FONT_KINGHWA,
    fontSize: "calc(8px*var(--app-text-scale,1))",
    fontWeight: "normal",
    color: "#aaaaaa",
    whiteSpace: "nowrap",
  },
  value: {
    fontFamily: FONT_KINGHWA,
    fontSize: "calc(13px*var(--app-text-scale,1))",
    fontWeight: "normal",
    color: "#333333",
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  valueHighlight: {
    letterSpacing: 0.2,
    color: "#111111",
  },
  valueEditable: {
    cursor: "pointer",
  },
  valueInput: {
    fontFamily: FONT_KINGHWA,
    fontSize: "calc(13px*var(--app-text-scale,1))",
    fontWeight: "normal",
    color: "#333333",
    border: "none",
    borderBottom: "1px solid #999999",
    background: "transparent",
    outline: "none",
    width: 60,
    padding: 0,
    minWidth: 0,
  },
  signatureText: {
    fontFamily: FONT_SIGNATURE,
    fontSize: "calc(15px*var(--app-text-scale,1))",
    color: "#888888",
    whiteSpace: "nowrap",
    display: "inline-block",
  },
  bottomArea: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    borderTop: "1px dashed #eaeaea",
    paddingTop: 8,
    marginTop: 8,
    position: "relative",
    top: 1,
    zIndex: 1,
  },
  bottomLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  idBottomLabel: {
    fontFamily: FONT_SERIF,
    fontStyle: "normal",
    fontSize: "calc(11px*var(--app-text-scale,1))",
    fontWeight: 500,
    color: "#888888",
    letterSpacing: 0.3,
    lineHeight: 1,
    whiteSpace: "nowrap",
  },
  idBottomValue: {
    fontFamily: FONT_SERIF,
    fontStyle: "normal",
    fontSize: "calc(11px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "#888888",
    letterSpacing: 0.3,
    lineHeight: 1,
    whiteSpace: "nowrap",
  },
  bottomRight: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  badgeBottom: {
    fontFamily: FONT_SERIF,
    fontStyle: "normal",
    fontSize: "calc(11px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "#888888",
    letterSpacing: 0.3,
    lineHeight: 1,
    whiteSpace: "nowrap",
  },
  enterIcon: {
    color: "#888888",
    cursor: "pointer",
    flexShrink: 0,
  },

  // ── 自定义 CSS 弹窗 ──────────────────────────────
  modalOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 50,
    background: "transparent",
    display: "flex",
    alignItems: "flex-end",
  },
  modalPanel: {
    width: "100%",
    maxHeight: "88%",
    background: "#ffffff",
    borderRadius: "16px 16px 0 0",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px 10px",
    flexShrink: 0,
  },
  modalTitle: {
    fontSize: "calc(15px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "#222222",
  },
  modalCloseBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 999,
    border: "none",
    background: "rgba(0, 0, 0, 0.05)",
    color: "#333333",
  },
  modalBody: {
    flex: 1,
    minHeight: 0,
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column",
  },
  modalTextarea: {
    flex: 1,
    minHeight: 340,
    resize: "vertical",
    fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
    fontSize: "calc(12px*var(--app-text-scale,1))",
    lineHeight: 1.6,
    color: "#333333",
    background: "#fafafa",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: 10,
    outline: "none",
    boxSizing: "border-box",
  },
  modalFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    padding: "0 16px 16px",
    marginTop: -8,
    flexShrink: 0,
  },
  modalIconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 38,
    height: 38,
    borderRadius: 10,
    border: "1px solid #e3e3e3",
    background: "#fafafa",
    color: "#333333",
  },
  modalIconBtnPrimary: {
    background: "#222222",
    color: "#ffffff",
    border: "1px solid #222222",
  },
  subOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 60,
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  subPanel: {
    width: "100%",
    maxHeight: "70%",
    background: "#ffffff",
    borderRadius: 14,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  subHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderBottom: "1px solid #ececec",
    flexShrink: 0,
  },
  subTitle: {
    fontSize: "calc(14px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "#222222",
  },
  subScroll: {
    flex: 1,
    overflowY: "auto",
    padding: 12,
  },
  presetAddRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    borderBottom: "1px solid #ececec",
    flexShrink: 0,
  },
  presetAddInput: {
    flex: 1,
    minWidth: 0,
    fontSize: "calc(13px*var(--app-text-scale,1))",
    color: "#333333",
    background: "#fafafa",
    border: "1px solid #e3e3e3",
    borderRadius: 8,
    padding: "8px 10px",
    outline: "none",
    boxSizing: "border-box",
  },
  presetAddBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    flexShrink: 0,
    borderRadius: 8,
    border: "1px solid #e3e3e3",
    background: "#fafafa",
    color: "#333333",
  },
  presetEmpty: {
    padding: "24px 8px",
    textAlign: "center",
    fontSize: "calc(12px*var(--app-text-scale,1))",
    color: "#999999",
  },
  presetItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "10px 8px",
    borderBottom: "1px solid #f0f0f0",
  },
  presetItemInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    cursor: "pointer",
  },
  presetItemName: {
    fontSize: "calc(13px*var(--app-text-scale,1))",
    fontWeight: 600,
    color: "#222222",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  presetItemDate: {
    fontSize: "calc(10px*var(--app-text-scale,1))",
    color: "#999999",
  },
  presetDeleteBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "#c04b4b",
    flexShrink: 0,
  },
};

export function StoryCharacterSelect({ onSelect, onClose }: StoryCharacterSelectProps) {
  const [characters, setCharacters] = useState(() => loadCharacters());
  const [editingGenderId, setEditingGenderId] = useState<string | null>(null);
  const [genderDraft, setGenderDraft] = useState("");

  // ── 自定义 CSS ──────────────────────────────────
  const [activeCustomCss, setActiveCustomCss] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [customCssDraft, setCustomCssDraft] = useState("");

  useEffect(() => {
    try {
      const raw = kvGet(CSS_ACTIVE_KEY);
      if (typeof raw === "string" && raw) setActiveCustomCss(raw);
    } catch {
      // 忽略读取失败，使用默认样式
    }
  }, []);

  function openCssModal() {
    setCustomCssDraft(activeCustomCss);
    setCssModalOpen(true);
  }

  // 应用 = 立即让 CSS 生效并关闭弹窗，不依赖 window.prompt。
  // 部分宿主容器（内嵌 Web/Hybrid 容器）不支持浏览器原生的 prompt/alert/confirm，
  // 调用它们可能直接抛错或卡住，导致「样式其实已经生效，但弹窗关不掉、看起来像没反应」。
  // 命名/存档改用 CSSSchemeBar（跟剧情界面同一个组件、同一套「保存方案/加载方案」逻辑），
  // 完全不用原生对话框，这里只负责让 CSS 立即生效。
  function handleSaveCss() {
    const css = customCssDraft;
    setActiveCustomCss(css);
    try {
      kvSet(CSS_ACTIVE_KEY, css);
    } catch {
      // 忽略保存失败，不影响当前已生效的样式
    }
    setCssModalOpen(false);
  }

  function startEditGender(event: MouseEvent, characterId: string, currentGender: string) {
    event.stopPropagation();
    setEditingGenderId(characterId);
    setGenderDraft(currentGender === "—" ? "" : currentGender);
  }

  function commitGender(characterId: string) {
    updateCharacter(characterId, { gender: genderDraft.trim() || undefined });
    setCharacters(loadCharacters());
    setEditingGenderId(null);
  }

  return (
    <div style={styles.shell} className="ccs-shell">
      {/* 只保留字体引入，不放任何布局相关的全局规则，避免宿主容器解析不完整 */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600;1,700&family=Noto+Sans+SC:wght@300;400;500&family=Dancing+Script:wght@600&display=swap');`}</style>
      <style>{`@import url("https://fontsapi.zeoseven.com/309/main/result.css");`}</style>
      {/* 锁定 ID CARD 标题 / 五个标签(Name/Gender/Archives/Round/ID) / ID变量 / NO.编号 / Round / Archives / 中文小标签 / 头像名字标签 / 姓名与性别变量 字体，并强制去掉顶栏按钮的方形容器（防止被外部全局样式，哪怕带 !important，覆盖） */}
      <style>{`
        .ccs-title { font-family: ${FONT_SERIF} !important; font-style: italic !important; }
        .ccs-round { font-family: ${FONT_SIGNATURE} !important; }
        .ccs-value.ccs-archive { font-family: ${FONT_SIGNATURE} !important; }
        .ccs-label-en { font-family: ${FONT_SERIF} !important; font-style: italic !important; }
        .ccs-id-label { font-family: ${FONT_SERIF} !important; font-style: normal !important; }
        .ccs-id-value { font-family: ${FONT_SERIF} !important; font-style: normal !important; }
        .ccs-badge { font-family: ${FONT_SERIF} !important; font-style: normal !important; }
        .ccs-label-cn { font-family: ${FONT_KINGHWA} !important; font-weight: normal !important; }
        .ccs-tag { font-family: ${FONT_KINGHWA} !important; font-weight: normal !important; }
        .ccs-value { font-family: ${FONT_KINGHWA} !important; font-weight: normal !important; }
        .ccs-value-input { font-family: ${FONT_KINGHWA} !important; font-weight: normal !important; }
        .ccs-back-btn, .ccs-css-btn {
          background: transparent !important;
          border: none !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          -webkit-tap-highlight-color: transparent !important;
          -webkit-appearance: none !important;
          appearance: none !important;
        }
        /* 与剧情界面 story.css 里 .story-header-content 的同一条窄屏规则保持一致，
           否则手机上两个界面的顶栏高度会不一样（选角界面此前没有这条规则）。
           内联样式优先级更高，这里必须加 !important 才能覆盖 styles.headerContent。 */
        @media (max-width: 640px) {
          .ccs-header-content {
            padding: 0 16px 12px !important;
          }
          .ccs-header-left,
          .ccs-header-right {
            margin-top: 6px !important;
          }
        }
      `}</style>
      {activeCustomCss ? <style dangerouslySetInnerHTML={{ __html: activeCustomCss }} /> : null}

      <div style={styles.header} className="ccs-header">
        <div style={styles.headerSafeArea} className="ccs-header-safe-area" />
        <div style={styles.headerContent} className="ccs-header-content">
          <div style={styles.headerLeft} className="ccs-header-left">
            <button style={styles.bareBtn} className="ccs-back-btn" onClick={onClose} aria-label="返回">
              <ChevronLeft size={18} />
            </button>
          </div>
          <div style={styles.headerCenter} className="ccs-header-title">STORY</div>
          <div style={styles.headerRight} className="ccs-header-right">
            <button style={styles.bareBtn} className="ccs-css-btn" onClick={openCssModal} aria-label="自定义 CSS">
              <PaintbrushVertical size={16} />
            </button>
          </div>
        </div>
      </div>

      {characters.length === 0 ? (
        <div style={styles.empty} className="ccs-empty">
          <UserRound size={28} opacity={0.5} className="ccs-empty-icon" />
          <div className="ccs-empty-text">还没有角色卡，请先创建或导入角色卡，再进入剧情。</div>
        </div>
      ) : (
        <div style={styles.scroll} className="ccs-scroll">
          {characters.map((character, index) => {
            const { archiveCount, roundCount } = getStoryArchiveStats(character.id);
            const gender = character.gender || "—";
            const isEditingGender = editingGenderId === character.id;
            const shortId = character.id.slice(-6).toUpperCase();

            return (
              <div style={styles.slide} className="ccs-slide" key={character.id}>
                <div
                  style={styles.card}
                  className="ccs-card"
                >
                  {/* 纵向虚线装饰：顶到卡片上下边缘，位于渐变条右侧、NO 左侧，偏向 NO 一侧 */}
                  <span style={styles.vertDivider} className="ccs-vert-divider" />
                  <div style={styles.topRow} className="ccs-top-row">
                    <div style={styles.leftCol} className="ccs-left-col">
                      {/* 三箭头装饰：固定在头像正上方、与右侧 ID CARD 标题同一行高度 */}
                      <div style={styles.leftDeco} className="ccs-left-deco">
                        <span style={styles.leftDecoBar} className="ccs-left-deco-bar" />
                        <span style={styles.leftDecoArrows} className="ccs-left-deco-arrows">&gt;&gt;&gt;</span>
                      </div>
                      <div style={styles.avatarBox} className="ccs-avatar-box">
                        <div style={styles.avatarInner} className="ccs-avatar-inner">
                          {character.avatar ? (
                            <img src={character.avatar} alt={character.name} style={styles.avatar} className="ccs-avatar-img" />
                          ) : (
                            <div style={styles.avatarFallback} className="ccs-avatar-fallback">{character.name.slice(0, 1)}</div>
                          )}
                        </div>
                        <div style={styles.tagLeft} className="ccs-tag">{character.name}</div>
                      </div>
                    </div>

                    <div style={styles.rightCol} className="ccs-right-col">
                      <div style={styles.rightDeco} className="ccs-right-deco">
                        <span style={styles.rightDecoDot} className="ccs-right-deco-dot" />
                        <span style={styles.rightDecoDot} className="ccs-right-deco-dot" />
                        <span style={styles.rightDecoDot} className="ccs-right-deco-dot" />
                      </div>
                      <div style={styles.mainTitle} className="ccs-title">ID CARD</div>
                      <div style={styles.titleDivider} className="ccs-title-divider" />

                      <div style={styles.infoList} className="ccs-info-list">
                        <div style={styles.infoRow} className="ccs-info-row ccs-info-field">
                          <div style={styles.labelAuto} className="ccs-label-auto">
                            <span style={styles.labelEn} className="ccs-label-en">Name</span>
                            <span style={styles.labelCn} className="ccs-label-cn">[姓名]</span>
                          </div>
                          <div style={{ ...styles.value, ...styles.valueHighlight }} className="ccs-value ccs-value-highlight">{character.name}</div>
                        </div>

                        <div style={styles.infoRow} className="ccs-info-row ccs-info-field">
                          <div style={styles.labelAuto} className="ccs-label-auto">
                            <span style={styles.labelEn} className="ccs-label-en">Gender</span>
                            <span style={styles.labelCn} className="ccs-label-cn">[性别]</span>
                          </div>
                          {isEditingGender ? (
                            <input
                              style={styles.valueInput}
                              className="ccs-value-input"
                              autoFocus
                              value={genderDraft}
                              placeholder="自定义"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setGenderDraft(event.target.value)}
                              onBlur={() => commitGender(character.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") { event.currentTarget.blur(); }
                                if (event.key === "Escape") { setEditingGenderId(null); }
                              }}
                            />
                          ) : (
                            <div
                              style={{ ...styles.value, ...styles.valueEditable }}
                              className="ccs-value ccs-value-editable"
                              onClick={(event) => startEditGender(event, character.id, gender)}
                            >
                              {gender}
                            </div>
                          )}
                        </div>

                        <div style={styles.infoRow} className="ccs-info-row ccs-info-field">
                          <div style={styles.labelAuto} className="ccs-label-auto">
                            <span style={styles.labelEn} className="ccs-label-en">Archives</span>
                            <span style={styles.labelCn} className="ccs-label-cn">[归档]</span>
                          </div>
                          <div style={styles.signatureText} className="ccs-value ccs-archive">{archiveCount}</div>
                        </div>

                        <div style={styles.infoRow} className="ccs-info-row ccs-info-field">
                          <div style={styles.labelAuto} className="ccs-label-auto">
                            <span style={styles.labelEn} className="ccs-label-en">Round</span>
                            <span style={styles.labelCn} className="ccs-label-cn">[轮数]</span>
                          </div>
                          <div style={styles.signatureText} className="ccs-round">{String(roundCount).padStart(2, "0")}</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={styles.bottomArea} className="ccs-bottom-area">
                    <div style={styles.bottomLeft} className="ccs-bottom-left">
                      <QrCode size={15} strokeWidth={1.5} className="ccs-qr-deco" style={{ color: "#888888", flexShrink: 0 }} />
                      <span style={styles.idBottomLabel} className="ccs-id-label">ID</span>
                      <span style={styles.idBottomValue} className="ccs-id-value">{shortId}</span>
                    </div>
                    <div style={styles.bottomRight} className="ccs-bottom-right">
                      <div style={styles.badgeBottom} className="ccs-badge">NO.{index + 1}</div>
                      <SquareChevronRight
                        size={15}
                        strokeWidth={1.5}
                        style={styles.enterIcon}
                        className="ccs-enter"
                        role="button"
                        tabIndex={0}
                        aria-label="进入"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(character.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation();
                            onSelect(character.id);
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {cssModalOpen && (
        <div
          style={{
            position: "absolute", inset: 0, zIndex: 50,
            background: "#ffffff",
            display: "flex", flexDirection: "column",
          }}
          className="ccs-css-page"
        >
          {/* 顶栏样式与剧情界面「页面样式」独立页完全一致（padding/边框/字号/字距/大小写都一样），
              唯一的区别是关闭按钮：这里沿用选角界面原本就有的圆形按钮样式（28×28、无边框、
              rgba(0,0,0,0.05) 底色），剧情界面那边的关闭按钮已经改成和这个一样了。 */}
          <div
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "52px 20px 14px",
              borderBottom: "1px solid rgba(0,0,0,0.04)",
            }}
            className="ccs-css-page-header"
          >
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "#94a3b8" }}>
              页面样式
            </span>
            <button style={styles.modalCloseBtn} className="ccs-modal-close-btn" onClick={() => setCssModalOpen(false)} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }} className="ccs-css-page-body">
            <textarea
              style={styles.modalTextarea}
              className="ccs-modal-textarea"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 在这里写选角界面的自定义 CSS，例如：\n.ccs-card { border-radius: 20px !important; } */`}
            />
            {/* 与剧情界面自定义 CSS 面板同一套六按钮布局、同一套逻辑：
                左边三个方案图标按钮（保存方案/加载方案/导入）来自 CSSSchemeBar，
                右边「加载示例/清除/应用」三个按钮统一用 height:36 对齐左边的 36×36 图标按钮，
                避免文字按钮因为用竖向 padding 撑高度而显得比图标按钮更扁、上下对不齐。 */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }} className="ccs-modal-footer">
              <CSSSchemeBar
                target="charSelect"
                currentCSS={customCssDraft}
                onLoad={setCustomCssDraft}
                btnStyle={{
                  border: "none",
                  background: "transparent",
                  color: "#333333",
                }}
                modalVars={{
                  panel: "#ffffff",
                  border: "#ececec",
                  text: "#222222",
                  textDim: "#999999",
                  input: "#fafafa",
                  inputBorder: "#e3e3e3",
                  accent: "#222222",
                }}
              />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, height: 36, borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "none", background: "transparent", color: "#333333",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, height: 36, borderRadius: 12,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "none", background: "transparent", color: "#333333",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={handleSaveCss}
                style={{
                  flex: 1, height: 36, borderRadius: 12, border: "none",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "#222222", color: "#ffffff",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
