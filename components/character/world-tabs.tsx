"use client";

// 世界文件夹 tab 条 + 文件夹编辑 sheet + 新建文件夹 sheet
// 视觉隐喻：每个世界 = 一份牛皮纸案卷，激活的 tab 是「翻开的那份」，
// 与画布纸面连成一体；编辑模式下拍立得可以拖到 tab 上「归档」进别的世界。

import { useState } from "react";
import type { CharacterWorldGroup } from "@/lib/character-world-storage";
import { DEFAULT_CHARACTER_WORLD_ID, DEFAULT_WORLD_FOLDER_COLOR } from "@/lib/character-world-storage";
import { ColorWheelPicker } from "./color-wheel-picker";

/** 文件夹「编辑」白圆按钮上的铅笔图标，与角色卡片编辑按钮的铅笔样式保持一致 */
function IconPencilTiny() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorldFolderStrip({
  groups,
  currentWorldId,
  memberCounts,
  dropTargetWorldId,
  onSelect,
  onOpenEditor,
  onOpenCreate,
}: {
  groups: CharacterWorldGroup[];
  currentWorldId: string;
  memberCounts: Map<string, number>;
  /** 拖拽拍立得悬停中的文件夹（高亮为可归档状态） */
  dropTargetWorldId: string | null;
  /** 点击关闭态文件夹 → 切换选中/打开 */
  onSelect: (worldId: string) => void;
  /** 点开态文件夹上的铅笔 → 打开文件夹编辑 */
  onOpenEditor: () => void;
  onOpenCreate: () => void;
}) {
  const currentCount = memberCounts.get(currentWorldId) ?? 0;

  return (
    <div className="wtf-section" style={{ paddingTop: 25 }}>
      <div style={{ padding: '0 16px', marginBottom: 6 }}>
        <div className="ccf-section-header" style={{ padding: 0 }}>
          <span className="ccf-section-title">Card Folder</span>
        </div>
        <div style={{ fontSize: 12, color: '#999', fontWeight: 500, marginTop: 2 }}>
          This folder has received <strong style={{ color: '#333' }}>{currentCount}</strong> cards
        </div>
      </div>
    <div className="wtf-strip">
      <style>{`
        .wtf-section {
          display: flex;
          flex-direction: column;
        }
        .wtf-strip {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          scroll-snap-type: x proximity;
          scroll-padding-inline: 16px;
          -webkit-overflow-scrolling: touch;
          /* overflow-x: auto 会连带把 overflow-y 也变成 auto（浏览器行为，
             两者不能一个 auto 一个 visible），所以文件夹打开态卡片上探
             （.wtf-item-active .wtf-peek-card 的 top: -22%）会被这层的
             上边缘裁掉一截，卡片顶部露出白边。顶部 padding 只要盖住
             最大号文件夹（128px 宽，high ≈96px）弹起卡片所需的量（约
             0.22 * 96 ≈ 21px）再留一点余量就够，28px 已经有 7px 余量，
             不需要之前 42px 那么多——收窄这块让文件夹条整体上移，
             靠近上方的说明文字。
             左右 padding 保持一致（16px），并加上 scroll-padding-inline，
             这样文件夹多到需要横向滚动时，两端也始终留出这圈空隙，
             不会有文件夹贴到屏幕边缘。 */
          /* 底部 padding 从 14 加到 26——上次把文件夹到底栏的间距硬对齐
             成跟文件夹到上方文字一样（34px），结果显得文件夹和底栏太挤。
             现在只保留「文件夹靠近上方文字」这一半，底部这块单独放宽，
             不再强制和上面对齐。 */
          padding: 28px 16px 26px 16px;
          scrollbar-width: none;
        }
        .wtf-strip::-webkit-scrollbar { display: none; }
        .wtf-item {
          position: relative;
          flex: 0 0 30%;
          min-width: 92px;
          max-width: 128px;
          scroll-snap-align: start;
          display: flex;
          flex-direction: column;
          align-items: center;
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
        }
        .wtf-folder {
          position: relative;
          width: 100%;
          aspect-ratio: 4 / 3;
        }
        .wtf-folder-back,
        .wtf-folder-flap {
          position: absolute;
          inset: 0;
          box-sizing: border-box;
        }
        /* 后盖：磨砂玻璃质感，半透明 + blur */
        .wtf-folder-back {
          border-radius: 10px;
          backdrop-filter: blur(12px) saturate(1.4);
          -webkit-backdrop-filter: blur(12px) saturate(1.4);
          opacity: 0.75;
          box-shadow: 0 6px 14px rgba(50,52,56,0.16);
          border: 1px solid rgba(255,255,255,0.3);
        }
        /* 前盖：带突起的文件夹标签形状——半透明毛玻璃，不跟随 group.color 上色，
           让后盖的颜色透出来；不做歪斜旋转，始终与后盖对齐成一个方正的长方形，
           打开态只做垂直方向的上移，不叠加旋转。
           只用 top 过渡（不叠加 transform: translateY），否则 transform 会把
           前盖底边也一起挪走，导致打开态时前盖底边和后盖底边对不齐 */
        .wtf-folder-flap {
          clip-path: polygon(0 22%, 34% 22%, 44% 4%, 100% 4%, 100% 100%, 0 100%);
          background: rgba(255, 255, 255, 0.4);
          backdrop-filter: blur(8px) saturate(1.4);
          -webkit-backdrop-filter: blur(8px) saturate(1.4);
          border: 1px solid rgba(255, 255, 255, 0.55);
          border-radius: 10px;
          transition: top 0.2s cubic-bezier(0.34,1.56,0.64,1);
        }
        .wtf-item-active .wtf-folder-flap { top: 50%; }
        .wtf-item:not(.wtf-item-active) .wtf-folder-flap { top: 20%; }
        .wtf-peek-card {
          position: absolute;
          left: 50%;
          background: #f7f7f6;
          border: 1px solid rgba(50,52,56,0.14);
          border-radius: 6px;
          box-shadow: 0 2px 5px rgba(50,52,56,0.16);
          transition: top 0.2s cubic-bezier(0.34,1.56,0.64,1), transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
        }
        /* 未打开：卡片躺在文件夹里面（叠在后盖和前盖之间，前盖盖住大半，
           只从标签缺口露一点边），长宽比始终 3:4（竖版）；宽度收窄一点，
           避免卡片底边和后盖底边挤在一起只剩一条灰线 */
        .wtf-peek-card {
          top: 44%;
          width: 54%;
          aspect-ratio: 3 / 4;
          transform: translate(-50%, -50%) rotate(-3deg);
        }
        /* 打开：前盖收得更矮（top 加大），卡片明显上移探出文件夹上方，
           宽度和长宽比都不变（3:4），只有位置/角度变化 */
        .wtf-item-active .wtf-peek-card {
          top: -22%;
          transform: translateX(-50%) rotate(-4deg);
        }
        .wtf-edit-btn {
          position: absolute;
          top: -6px;
          right: -6px;
          width: 26px;
          height: 26px;
          padding: 0;
          border-radius: 999px;
          background: #ffffff;
          color: rgba(40, 42, 46, 0.72);
          border: 1px solid rgba(30, 32, 36, 0.10);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(40,42,46,0.16);
        }
        .wtf-edit-btn svg {
          width: 13px;
          height: 13px;
        }
        .wtf-name {
          margin-top: 14px;
          font-size: 12px;
          font-weight: 600;
          color: #333;
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wtf-count {
          font-size: 10.5px;
          color: #999;
          margin-top: 1px;
        }
        .wtf-item-drop .wtf-folder-back,
        .wtf-item-drop .wtf-folder-flap {
          outline: 2px dashed #111;
          outline-offset: 2px;
        }
        .wtf-new {
          flex: 0 0 30%;
          min-width: 92px;
          max-width: 128px;
          aspect-ratio: 4 / 3;
          margin-left: 4px;
          border: 2px dashed rgba(0,0,0,0.18);
          border-radius: 8px;
          background: none;
          color: rgba(0,0,0,0.35);
          font-size: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          scroll-snap-align: start;
          align-self: flex-start;
        }
      `}</style>
      {groups.map(group => {
        const active = group.id === currentWorldId;
        const dropping = group.id === dropTargetWorldId;
        return (
          <div
            key={group.id}
            role="button"
            tabIndex={0}
            data-world-tab-id={group.id}
            className={`wtf-item ${active ? "wtf-item-active" : ""} ${dropping ? "wtf-item-drop" : ""}`}
            onClick={() => { if (!active) onSelect(group.id); }}
            onKeyDown={(e) => { if (!active && (e.key === "Enter" || e.key === " ")) onSelect(group.id); }}
            title={active ? group.name : `打开「${group.name}」`}
          >
            <div className="wtf-folder">
              <div className="wtf-folder-back" style={{ background: group.color }} />
              <div className="wtf-peek-card" />
              <div className="wtf-folder-flap" />
              {active && (
                <button
                  type="button"
                  className="wtf-edit-btn"
                  aria-label="编辑这份文件夹"
                  onClick={(e) => { e.stopPropagation(); onOpenEditor(); }}
                >
                  <IconPencilTiny />
                </button>
              )}
            </div>
            <span className="wtf-name">{group.name}</span>
            <span className="wtf-count">{memberCounts.get(group.id) ?? 0}</span>
          </div>
        );
      })}
      <button type="button" className="wtf-new" onClick={onOpenCreate} aria-label="新建世界">
        ＋
      </button>
    </div>
    </div>
  );
}

/** 文件夹编辑：改名 / 世界观描述 / 删除（角色并回默认世界） */
export function WorldCaseSheet({
  group,
  onRename,
  onUpdateDescription,
  onUpdateColor,
  onDelete,
  onClose,
}: {
  group: CharacterWorldGroup;
  onRename: (name: string) => void;
  onUpdateDescription: (description: string) => void;
  /** 色轮拖拽/输入即时生效，不等「完成」按钮（与 name/description 的提交时机不同，避免拖拽卡顿感） */
  onUpdateColor: (color: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDefault = group.id === DEFAULT_CHARACTER_WORLD_ID;

  const save = () => {
    if (name.trim() && name.trim() !== group.name) onRename(name.trim());
    if (description.trim() !== group.description) onUpdateDescription(description.trim());
    onClose();
  };

  return (
    <div className="wt-modal" onClick={save}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-kicker">CASE FILE</div>
        <label className="wt-paper-label">世界名称</label>
        <input
          className="wt-paper-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="世界名称"
          disabled={isDefault}
        />
        <label className="wt-paper-label">世界观描述（会注入该世界所有角色的上下文）</label>
        <textarea
          className="wt-paper-textarea"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <label className="wt-paper-label">文件夹颜色</label>
        <ColorWheelPicker value={group.color} onChange={onUpdateColor} />
        <div className="wt-paper-actions">
          {!isDefault && (
            confirmDelete ? (
              <>
                <span className="wt-paper-confirm">确认删除？角色将并回默认世界</span>
                <button type="button" className="wt-btn wt-btn-danger" onClick={onDelete}>删除</button>
                <button type="button" className="wt-btn" onClick={() => setConfirmDelete(false)}>取消</button>
              </>
            ) : (
              <button type="button" className="wt-btn wt-btn-danger" onClick={() => setConfirmDelete(true)}>删除文件夹</button>
            )
          )}
          {/* 确认删除态下不留 spacer，让「删除/取消」和「完成」共用 .wt-paper-actions
              统一的 8px gap，间距保持一致；非确认态仍用 spacer 把「删除文件夹」推到左边、
              「完成」推到右边 */}
          {!confirmDelete && <span className="wt-paper-spacer" />}
          <button type="button" className="wt-btn wt-btn-done" onClick={save}>完成</button>
        </div>
      </div>
    </div>
  );
}

/** 新建文件夹 */
export function NewWorldSheet({
  onCreate,
  onClose,
}: {
  /** color 为色轮当前选中的 hex；调用方创建后可直接传给 createCharacterWorldGroup(name, color) */
  onCreate: (name: string, color: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_WORLD_FOLDER_COLOR);
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), color);
  };
  return (
    <div className="wt-modal" onClick={onClose}>
      <div className="wt-paper" onClick={e => e.stopPropagation()}>
        <div className="wt-paper-kicker">NEW CASE</div>
        <label className="wt-paper-label">新文件夹名称</label>
        <input
          className="wt-paper-input"
          value={name}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
        />
        <label className="wt-paper-label">文件夹颜色</label>
        <ColorWheelPicker value={color} onChange={setColor} />
        <div className="wt-paper-actions">
          <button type="button" className="wt-btn" onClick={onClose}>取消</button>
          <span className="wt-paper-spacer" />
          <button type="button" className="wt-btn wt-btn-done" disabled={!name.trim()} onClick={submit}>建立</button>
        </div>
      </div>
    </div>
  );
}
