import type { Mission } from '../../types';

/** Canonical Final Mission candidates shared by the Admin client and Functions. */
export const FINAL_MISSIONS: Mission[] = [
  { id: 'final_01', area: '最終', region: 'ALL', title: '乗降客数トップ10の駅を5つ訪れろ（非山手線必須）', description: '1日の乗降客数全国トップ10の駅のうち5駅を訪れよ。非山手線の駅を必ず1駅以上含めること。各駅での写真を送ること。', points: 100, type: 'CHECKIN' },
  { id: 'final_02', area: '最終', region: 'ALL', title: '路面電車＋モノレールの両方を撮影しろ', description: '「路面電車とモノレール」を合計3つ(それぞれ1つずつともう一つはどちらからか)撮影せよ。両方の写真を送ること。', points: 100, type: 'PHOTO' },
  { id: 'final_03', area: '最終', region: 'ALL', title: '東京・神奈川・千葉・埼玉のいずれかの庁舎に行け', description: '1都3県の県庁・都庁を訪れよ。逃走者はゲーム終了まで都庁前駅を利用禁止。庁舎前での写真を送ること。', points: 100, type: 'CHECKIN' },
  { id: 'final_04', area: '最終', region: 'ALL', title: '2時間以内に異なる3社の車両が並ぶ瞬間を撮影せよ', description: '2時間以内に、異なる鉄道会社3社の車両が並んでいる瞬間を1枚の写真に収めて送ること。', points: 100, type: 'PHOTO' },
];
