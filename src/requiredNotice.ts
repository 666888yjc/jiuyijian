// 「这一栏还没填」那句解释的唯一出处（R106）。
//
// 为什么收成一处：R99 与 R105 各修掉一颗"按状态禁用、按下什么都不会发生"的按钮，改法都是"按下时点名缺哪一栏"。
// 产品里还有三颗同一形状的（见 `dev/disabled-census.mjs` 的普查），如果每页各写一句，
// 五句措辞迟早分叉——而分叉之后，"界面说的范围与代码控制流一致"这条纪律就没法用一条判据钉住（R64/R67/R84 同族）。
//
// 写法纪律：句子只说**此刻缺哪一栏**与**填上之后能做什么**，不许编外部原因
// ——这三处都在本机状态里，根本没到服务器，所以不许出现"服务器要求""必填项校验失败"这种话。
export type RequiredTarget = "actionEdit" | "fieldValue" | "questionText" | "manualField";

const SENTENCES: Record<RequiredTarget, string> = {
  actionEdit: "请先写完这条行动的内容——空着保存不了。写完直接按「保存修改」就行。",
  fieldValue: "请先写上要改成的内容——这一栏空着没法保存，也没法确认。",
  questionText: "请先写上要问医生的那句话——空着加不进清单。",
  manualField: "「名称」和「内容」两栏都要写——只填一栏补不进清单。",
};

/** 缺这一栏时给家属看的那一句（可见文本，不靠颜色、不活在 title 里） */
export function requiredNotice(t: RequiredTarget): string {
  return SENTENCES[t];
}

/** 普查用：这一类句子必须全部出自这张表，页面里不许另有字面量 */
export const REQUIRED_TARGETS = Object.keys(SENTENCES) as RequiredTarget[];
