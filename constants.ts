import { Mission, GameConfig } from './types';

// ============================================================
// エリア定義
// ============================================================
export const REGIONS = ['ALL'];

// ============================================================
// 通常ミッションデータ（ポイント調整済み Ver.2.0）
// 調整基準：
// 15pt: 短時間・駅周辺で完結
// 20-25pt: 特定の路線選択や移動が必要
// 30-35pt: 広域移動や滞在時間が伴う
// 40-50pt: 複数箇所の訪問や高い計画性が必要
// ============================================================
export const MISSIONS: Mission[] = [
  // --- 初級：15pt（手軽に達成可能） ---
  { id: 'm02', area: 'ALL', region: 'ALL', title: '「北」から始まる駅に行け', description: '駅名が「北」の字で始まる駅の改札外で写真を撮影してLINEで送ること。', points: 15, type: 'PHOTO' },
  { id: 'm03', area: 'ALL', region: 'ALL', title: '駅名にひらがなが入る駅に行け', description: '駅名にひらがなを含む駅の改札外で写真を撮影してLINEで送ること。', points: 15, type: 'PHOTO' },
  { id: 'm06', area: 'ALL', region: 'ALL', title: '新〇〇駅に行け', description: '「新」で始まる駅名で、かつ〇〇駅が別に存在する駅の改札外で撮影。文字数不問。', points: 15, type: 'PHOTO' },
  { id: 'm07', area: 'ALL', region: 'ALL', title: '5文字以上の駅名の駅に行け', description: '駅名（ひらがな読みで5文字以上）の駅の改札外で写真を撮影してLINEで送ること。', points: 15, type: 'PHOTO' },
  { id: 'm14', area: 'ALL', region: 'ALL', title: '気動車を撮れ', description: 'ディーゼル車両（気動車）の写真をLINEで送ること。停車中・走行中どちらでもOK。', points: 15, type: 'PHOTO' },

  // --- 中級：20-25pt（移動やリサーチが必要） ---
  { id: 'm01', area: 'ALL', region: 'ALL', title: '接地している飛行機を撮れ', description: '地上にいる飛行機を写真に収めよ。空港の展望デッキ・フェンス越し等OK。', points: 20, type: 'PHOTO' },
  { id: 'm04', area: 'ALL', region: 'ALL', title: '日本地下鉄協会加盟の鉄道会社の駅を撮れ', description: '日本地下鉄協会に所属する鉄道会社の駅（駅入口・改札でもOK）を撮影。', points: 20, type: 'PHOTO' },
  { id: 'm08', area: 'ALL', region: 'ALL', title: '通過列車がある駅に降り立て', description: '通過列車が存在する駅（新幹線通過駅含む）で下車し、駅名標の写真を送ること。', points: 20, type: 'CHECKIN' },
  { id: 'm10', area: 'ALL', region: 'ALL', title: '国鉄型車両に乗車せよ', description: '国鉄時代に製造された車両に乗車し、車内または車両外観の写真を送ること。', points: 20, type: 'PHOTO' },
  { id: 'm12', area: 'ALL', region: 'ALL', title: '国立大学に行け（東京都以外）', description: '東京都以外にある国立大学のキャンパスを訪れ、大学名がわかる写真を送ること。', points: 20, type: 'PHOTO' },
  { id: 'm27', area: 'ALL', region: 'ALL', title: 'ハイブリッド車両を目撃せよ', description: 'ハイブリッド方式の鉄道車両を目撃し写真を送ること。形式がわかるとなお良し。', points: 20, type: 'PHOTO' },
  { id: 'm05', area: 'ALL', region: 'ALL', title: '日本海を撮れ', description: '日本海が写った写真をLINEで送ること。海岸・高台・車窓などどこからでもOK。', points: 25, type: 'PHOTO' },
  { id: 'm09', area: 'ALL', region: 'ALL', title: 'デッドセクションを通過せよ', description: '交直流切替区間を通過した証拠（放送・案内の写真や動画）を送ること。', points: 25, type: 'PHOTO' },
  { id: 'm21', area: 'ALL', region: 'ALL', title: 'BRTに乗れ', description: 'バス高速輸送システム（BRT）に乗車し、車内または車両外観の写真を送ること。', points: 25, type: 'PHOTO' },
  { id: 'm22', area: 'ALL', region: 'ALL', title: 'SLを画角に収めろ', description: '蒸気機関車（SL）の写真を送ること。動態・静態保存どちらでもOK。', points: 25, type: 'PHOTO' },
  { id: 'm26', area: 'ALL', region: 'ALL', title: '競馬場に行け', description: '競馬場（JRA・地方どちらでもOK）を訪れ、現地での写真を送ること。', points: 25, type: 'PHOTO' },

  // --- 上級：30-35pt（広域移動・長時間拘束） ---
  { id: 'm11', area: 'ALL', region: 'ALL', title: '世界遺産に行け', description: '日本国内の世界遺産を訪れ、現地での写真をLINEで送ること。', points: 30, type: 'PHOTO' },
  { id: 'm13', area: 'ALL', region: 'ALL', title: '温泉に入れ', description: '温泉施設に入浴し、施設の外観や入浴証明（領収書等）の写真を送ること。', points: 30, type: 'PHOTO' },
  { id: 'm15', area: 'ALL', region: 'ALL', title: '県境を2回跨げ', description: '異なる2組の県境を越えよ。移動経路がわかる写真または乗車券を送ること。', points: 30, type: 'PHOTO' },
  { id: 'm16', area: 'ALL', region: 'ALL', title: '隣駅が別の県の駅名標を撮れ', description: '在来線で隣駅が別県になる駅（かつ訪問駅自体も都外）の駅名標を撮影。', points: 30, type: 'PHOTO' },
  { id: 'm17', area: 'ALL', region: 'ALL', title: '甲信越に2時間滞在しろ', description: '山梨・長野・新潟のいずれかで2時間以上滞在せよ。到着時と出発時の写真を送ること。', points: 30, type: 'CHECKIN' },
  { id: 'm18', area: 'ALL', region: 'ALL', title: '東北に2時間滞在しろ', description: '東北6県のいずれかで2時間以上滞在せよ。到着時と出発時の写真を送ること。', points: 30, type: 'CHECKIN' },
  { id: 'm19', area: 'ALL', region: 'ALL', title: 'ほくほく線に残る「はくたか」の跡を見つけろ', description: 'ほくほく線沿線で特急はくたか時代の痕跡を発見し写真を送ること。', points: 30, type: 'PHOTO' },
  { id: 'm25', area: 'ALL', region: 'ALL', title: '「三」がつく駅を3箇所巡れ', description: '駅名に「三」という漢字が含まれる駅を3駅訪問し、各駅の写真を送ること。', points: 30, type: 'PHOTO' },
  { id: 'm28', area: 'ALL', region: 'ALL', title: '野生のハクチョウを目撃せよ', description: '野生のハクチョウの写真を送ること。公園の飼育個体は不可。', points: 30, type: 'PHOTO' },
  { id: 'm29', area: 'ALL', region: 'ALL', title: '駅舎内に温泉がある駅へ行け', description: '駅舎に温泉施設がある駅を訪れ、施設の案内板や入口の写真を送ること。', points: 30, type: 'CHECKIN' },
  { id: 'm32', area: 'ALL', region: 'ALL', title: '海に面していない県の県庁に行け', description: '内陸県（栃木・群馬・山梨等）の県庁舎を訪れ、写真を送ること。', points: 30, type: 'PHOTO' },
  { id: 'm20', area: 'ALL', region: 'ALL', title: '「動物を表す漢字」駅を3箇所巡れ', description: '駅名に動物を表す漢字が含まれる駅を3駅訪問。各駅の写真を送ること。', points: 35, type: 'PHOTO' },
  { id: 'm30', area: 'ALL', region: 'ALL', title: '第三セクター鉄道で新幹線駅間を移動せよ', description: '三セク鉄道を利用して新幹線駅から別の新幹線駅へ移動。乗車券等の写真を送ること。', points: 35, type: 'CHECKIN' },

  // --- 超上級：40-50pt（最難関クラス） ---
  { id: 'm24', area: 'ALL', region: 'ALL', title: '合計450m以上の高さの建物に登れ', description: '高さ100m以上かつ展望台がある建物に登り合計450m以上に。各展望台入場証明を送ること。', points: 40, type: 'PHOTO' },
  { id: 'm23', area: 'ALL', region: 'ALL', title: '漢数字「一〜十」駅を5箇所巡れ', description: '駅名に漢数字（一〜十）が含まれる駅を5駅巡れ（1数字1駅）。各駅の写真を送ること。', points: 50, type: 'PHOTO' },
  { id: 'm31', area: 'ALL', region: 'ALL', title: 'プロ競技場2ヶ所訪れろ（最低1ヶ所は東北）', description: 'プロスポーツ本拠地を2ヶ所訪問。うち最低1ヶ所は東北。各競技場の写真を送ること。', points: 50, type: 'PHOTO' },
];

// ============================================================
// 最終ミッション（100pt固定）
// ============================================================
export const FINAL_MISSIONS: Mission[] = [
  {
    id: 'final_01',
    area: '最終',
    region: 'ALL',
    title: '乗降客数トップ10の駅を5つ訪れろ（非山手線必須）',
    description: '1日の乗降客数全国トップ10の駅のうち5駅を訪れよ。非山手線の駅を必ず1駅以上含めること。各駅での写真を送ること。',
    points: 100,
    type: 'CHECKIN',
  },
  {
    id: 'final_02',
    area: '最終',
    region: 'ALL',
    title: '路面電車＋モノレールの両方を撮影しろ',
    description: '「路面電車とモノレール」を合計3つ(それぞれ1つずつともう一つはどちらからか)撮影せよ。両方の写真を送ること。',
    points: 100,
    type: 'PHOTO',
  },
  {
    id: 'final_03',
    area: '最終',
    region: 'ALL',
    title: '東京・神奈川・千葉・埼玉のいずれかの庁舎に行け',
    description: '1都3県の県庁・都庁を訪れよ。逃走者はゲーム終了まで都庁前駅を利用禁止。庁舎前での写真を送ること。',
    points: 100,
    type: 'CHECKIN',
  },
  {
    id: 'final_04',
    area: '最終',
    region: 'ALL',
    title: '2時間以内に異なる3社の車両が並ぶ瞬間を撮影せよ',
    description: '2時間以内に、異なる鉄道会社3社の車両が並んでいる瞬間を1枚の写真に収めて送ること。',
    points: 100,
    type: 'PHOTO',
  },
];

// 最終ミッションをランダムに1つ選ぶ関数
export const getRandomFinalMission = (): Mission => {
  return FINAL_MISSIONS[Math.floor(Math.random() * FINAL_MISSIONS.length)];
};

// ============================================================
// ゲーム初期設定
// ============================================================
export const INITIAL_GAME_CONFIG: GameConfig = {
  currentArea: 'ALL',
  currentRegion: 'ALL',
  announcement: 'ゲーム開始！安全運転で楽しみましょう。',
  isGameEnded: false,
  isGameOver: false,
  isFinalMissionActive: false,
  finalMissionEndTime: 0,
  day: 1,
  goalLat: 37.7547,
  goalLng: 140.4593,
  nextRevealTime: Date.now() + 30 * 60 * 1000,
  startTime: 0,
  gameStatus: 'PRE_GAME',
  broadcastMessage: '',
  broadcastTime: 0,
  missionMode: 'DIFFERENT',
  activeMissionA: null,
  activeMissionB: null,
  activeFinalMissionId: null,
  teamAScore: 0,
  teamBScore: 0,
  teamARole: 'RUNNER',
  teamBRole: 'ONI',
  logs: [],
};

export const TEAM_COLORS = [
  '#ef4444', // red  → Team A
  '#3b82f6', // blue → Team B
];