
export type Character = {
  id: string;
  name: string;
  avatar: string | null; // data URL 或外部 URL
  persona: string;       // 人设
  briefPersona?: string; // 简量版人设：注入到同世界有关系角色的「角色关系」marker，供对方了解 TA（防 OOC）
  briefPersonaUpdatedAt?: string; // 简介生成时间；早于 updatedAt 时编辑器提示「设定已更新，建议重新生成」
  wechatID?: string;     // 手机号格式的微信号
  personality?: string;    // 角色性格
  timeZone?: string;       // IANA 时区，例如 America/New_York；空值表示跟随系统时间
  tags?: string[];
  gender?: string;         // 性别，自由文本；目前仅在剧情选角卡片上可点击自定义
  createdAt: string;
  updatedAt: string;
  cardColor?: string;      // 角色卡片毛玻璃底色（色轮取色器输出的 hex/hsl），角色详情/编辑页设置
};
