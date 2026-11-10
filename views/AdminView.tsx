import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GameConfig, User, Mission, MissionCompletion } from '../types';
import { MISSIONS, DEFAULT_DYNAMIC_RULE_SETTINGS } from '../constants';
import {
  Users, Lock, Shield, Trophy, Play,
  AlertTriangle, Shuffle, MapPin,
  RefreshCw, QrCode, Copy, Check, Plus, Edit2, Trash2,
  Award, Sparkles, X, Send, Megaphone, ArrowLeftRight, Sliders
} from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'qrcode-svg';
import { signInAdmin, setupInitialAdmin, isAdminBootstrapCompleted } from '../src/infrastructure/firebase/auth';
import { resumePlayer, swapTeamRoles } from '../src/application/adminGameStateActions';
import { revealPlayerLocations } from '../src/application/adminReveal';
import type { AdminRevealScope } from '../src/game/adminReveal';
import { firebaseAdminGameStateGateway } from '../src/infrastructure/firebase/adminActions';
import { firebaseAdminRevealGateway } from '../src/infrastructure/firebase/adminRevealActions';
import { transitionGamePhase } from '../src/application/adminPhaseActions';
import { firebaseAdminPhaseGateway } from '../src/infrastructure/firebase/adminPhaseActions';
import { setMissionMode, assignMissions, syncMissionCatalog } from '../src/application/adminMissionActions';
import { firebaseAdminMissionGateway } from '../src/infrastructure/firebase/adminMissionActions';
import { adjustTeamScore } from '../src/application/adminScoreAdjustment';
import type { AdjustTeamScoreResult, ScoreAdjustmentReasonCode } from '../src/application/gameplayPorts';
import { firebaseAdminScoreAdjustmentGateway } from '../src/infrastructure/firebase/adminScoreAdjustmentActions';
import { prepareGameReset, executeGameReset } from '../src/application/gameReset';
import type { PrepareGameResetPreview } from '../src/application/gameplayPorts';
import { firebaseAdminGameResetGateway } from '../src/infrastructure/firebase/adminGameResetActions';
import { initializeGameSession } from '../src/application/initializeGameSession';
import { firebaseGameSessionInitializationGateway } from '../src/infrastructure/firebase/adminSessionActions';
import { createOrUpdateMission, deleteMission, awardMissionCompletionByAdmin } from '../src/infrastructure/firebase/missionStore';
import { isFirebaseMisconfigured } from '../src/infrastructure/firebase/firebaseClient';
import {
  sendAdminBroadcast,
  updateAdminRuleSettings,
  applyAdminPenaltyReveal,
} from '../src/infrastructure/firebase/clientFirestoreGateways';
import { adminChangePlayerTeam, adminDeletePlayer } from '../src/infrastructure/firebase/playerStore';
import type { VictoryMode } from '../src/game/types';

import {
  subscribeEmergencyLocationProjections,
  subscribeMissionCompletions,
} from '../src/infrastructure/firebase/subscriptions';
import type { EmergencyLocationProjection } from '../types';
import EmergencyProjectionMap from './EmergencyProjectionMap';

interface Props {
  config: GameConfig;
  users: User[];
  missions: Mission[];
}

const AdminView: React.FC<Props> = ({ config, users = [], missions = [] }) => {
  // 認証関連（メール不要のユーザーID・パスワード）
  const [adminIdInput, setAdminIdInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [isBootstrapCompleted, setIsBootstrapCompleted] = useState<boolean | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // 全体一斉通知
  const [broadcastInput, setBroadcastInput] = useState('');
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);

  // 汎用ルール可変設定
  const [ruleVictoryMode, setRuleVictoryMode] = useState<VictoryMode>(config.victoryMode ?? DEFAULT_DYNAMIC_RULE_SETTINGS.victoryMode);
  const [ruleShinkansenMaxMinutes, setRuleShinkansenMaxMinutes] = useState<number>(config.shinkansenMaxMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxMinutes);
  const [ruleShinkansenMaxSegments, setRuleShinkansenMaxSegments] = useState<number>(config.shinkansenMaxSegments ?? DEFAULT_DYNAMIC_RULE_SETTINGS.shinkansenMaxSegments);
  const [rulePostShinkansenWaitMinutes, setRulePostShinkansenWaitMinutes] = useState<number>(config.postShinkansenWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.postShinkansenWaitMinutes);
  const [rulePeriodicRevealIntervalMinutes, setRulePeriodicRevealIntervalMinutes] = useState<number>(config.periodicRevealIntervalMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealIntervalMinutes);
  const [rulePeriodicRevealDurationMinutes, setRulePeriodicRevealDurationMinutes] = useState<number>(config.periodicRevealDurationMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.periodicRevealDurationMinutes);
  const [ruleCaptureWaitMinutes, setRuleCaptureWaitMinutes] = useState<number>(config.captureWaitMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.captureWaitMinutes);
  const [ruleMissionPenaltyRevealMinutes, setRuleMissionPenaltyRevealMinutes] = useState<number>(config.missionPenaltyRevealMinutes ?? DEFAULT_DYNAMIC_RULE_SETTINGS.missionPenaltyRevealMinutes);
  const [isSavingRules, setIsSavingRules] = useState(false);

  // ペナルティ発動関連
  const [penaltyTargetPlayerId, setPenaltyTargetPlayerId] = useState<string>('');
  const [penaltyDurationMinutes, setPenaltyDurationMinutes] = useState<number>(10);
  const [isApplyingPenalty, setIsApplyingPenalty] = useState(false);

  // プレイヤー管理
  const [modifyingPlayerIds, setModifyingPlayerIds] = useState<Set<string>>(new Set());

  // ミッションタブ (配信 / 一覧・作成 / 達成履歴)
  const [missionTab, setMissionTab] = useState<'DISPATCH' | 'CATALOG' | 'COMPLETIONS'>('DISPATCH');
  const [missionSearch, setMissionSearch] = useState('');
  const [editingMission, setEditingMission] = useState<Mission | null>(null);
  const [isMissionModalOpen, setIsMissionModalOpen] = useState(false);
  const [manualAwardTeam, setManualAwardTeam] = useState<'A' | 'B'>('A');
  const [manualAwardMissionId, setManualAwardMissionId] = useState('');
  const [liveCompletions, setLiveCompletions] = useState<Array<MissionCompletion & { id: string }>>([]);

  // QRコード・招待
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);

  // スコア・フェーズ・セッション関連
  const [scoreTeam, setScoreTeam] = useState<'A' | 'B'>('A');
  const [scoreDeltaInput, setScoreDeltaInput] = useState('');
  const [scoreReasonCode, setScoreReasonCode] = useState<ScoreAdjustmentReasonCode>('CORRECTION');
  const [scoreAdjustmentResult, setScoreAdjustmentResult] = useState<Extract<AdjustTeamScoreResult, { ok: true }> | null>(null);
  const [resetPreview, setResetPreview] = useState<PrepareGameResetPreview | null>(null);
  const [resetConfirmationText, setResetConfirmationText] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionInitializationBusy, setSessionInitializationBusy] = useState(false);
  const sessionInitializationRequestIdRef = useRef<string | null>(null);
  const [searchDuration, setSearchDuration] = useState(10);
  const [manualMissionId, setManualMissionId] = useState('');
  const [emergencyProjections, setEmergencyProjections] = useState<EmergencyLocationProjection[]>([]);
  const [projectionUnavailable, setProjectionUnavailable] = useState(false);
  const [resumingPlayerIds, setResumingPlayerIds] = useState<Set<string>>(new Set());
  const roleSwapBusyRef = useRef(false);
  const roleSwapRequestIdRef = useRef<string | null>(null);
  const resumeBusyRef = useRef(new Set<string>());
  const revealBusyRef = useRef(false);
  const revealRequestIdsRef = useRef<Partial<Record<AdminRevealScope, string>>>({});
  const missionBusyRef = useRef(false);
  const scoreBusyRef = useRef(false);
  const resetBusyRef = useRef(false);
  const resetRequestIdRef = useRef<string | null>(null);
  const pendingScoreRequestRef = useRef<{ key: string; requestId: string } | null>(null);
  const missionRequestIdsRef = useRef<Record<string, string>>({});
  const pendingMissionModeRef = useRef<{ mode: 'SAME' | 'DIFFERENT'; requestId: string } | null>(null);

  // 招待URL
  const inviteUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}${window.location.pathname}#/`;
  }, []);

  // SVG QR Code -> Data URI (Biome安全・dangerouslySetInnerHTML回避)
  const qrDataUri = useMemo(() => {
    if (!inviteUrl) return '';
    try {
      const q = new QRCode({
        content: inviteUrl,
        padding: 2,
        width: 180,
        height: 180,
        color: '#0f172a',
        background: '#ffffff',
        ecl: 'M',
      });
      const svg = q.svg();
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    } catch {
      return '';
    }
  }, [inviteUrl]);

  const emergencyPlayerIds = useMemo(
    () => users.filter(user => user.status === 'EMERGENCY' && (user.team === 'A' || user.team === 'B')).map(user => user.id),
    [users],
  );

  // 緊急位置情報の購読
  useEffect(() => {
    if (!isAuthorized) {
      setEmergencyProjections([]);
      setProjectionUnavailable(false);
      return;
    }
    return subscribeEmergencyLocationProjections(
      emergencyPlayerIds,
      config.gameSessionId ?? '',
      projections => {
        setEmergencyProjections(projections);
        setProjectionUnavailable(false);
      },
      error => {
        console.error('Emergency location projection subscription failed:', error);
        setEmergencyProjections([]);
        setProjectionUnavailable(true);
      },
    );
  }, [isAuthorized, emergencyPlayerIds, config.gameSessionId]);

  // ミッション達成履歴の購読
  useEffect(() => {
    if (!isAuthorized || !config.gameSessionId) return;
    return subscribeMissionCompletions(
      config.gameSessionId,
      completions => setLiveCompletions(completions),
      err => console.error('Error subscribing mission completions:', err),
    );
  }, [isAuthorized, config.gameSessionId]);

  useEffect(() => {
    isAdminBootstrapCompleted()
      .then(completed => {
        setIsBootstrapCompleted(completed);
        if (!completed) {
          setIsSetupMode(true);
        }
      })
      .catch(err => console.error('Error checking bootstrap completion:', err));
  }, []);

  useEffect(() => {
    if (config.victoryMode) setRuleVictoryMode(config.victoryMode);
    if (config.shinkansenMaxMinutes !== undefined) setRuleShinkansenMaxMinutes(config.shinkansenMaxMinutes);
    if (config.shinkansenMaxSegments !== undefined) setRuleShinkansenMaxSegments(config.shinkansenMaxSegments);
    if (config.postShinkansenWaitMinutes !== undefined) setRulePostShinkansenWaitMinutes(config.postShinkansenWaitMinutes);
    if (config.periodicRevealIntervalMinutes !== undefined) setRulePeriodicRevealIntervalMinutes(config.periodicRevealIntervalMinutes);
    if (config.periodicRevealDurationMinutes !== undefined) setRulePeriodicRevealDurationMinutes(config.periodicRevealDurationMinutes);
    if (config.captureWaitMinutes !== undefined) setRuleCaptureWaitMinutes(config.captureWaitMinutes);
    if (config.missionPenaltyRevealMinutes !== undefined) setRuleMissionPenaltyRevealMinutes(config.missionPenaltyRevealMinutes);
  }, [
    config.victoryMode,
    config.shinkansenMaxMinutes,
    config.shinkansenMaxSegments,
    config.postShinkansenWaitMinutes,
    config.periodicRevealIntervalMinutes,
    config.periodicRevealDurationMinutes,
    config.captureWaitMinutes,
    config.missionPenaltyRevealMinutes,
  ]);

  const requireSessionId = (): string | null => {
    if (config.gameSessionId) return config.gameSessionId;
    toast.error('ゲームセッション初期化待ちです。先にSession初期化を実行してください。');
    return null;
  };

  // 1クリック一括初期化（Session初期化 ＋ 36件ミッションDB同期）
  const handleQuickSetupWizard = async (): Promise<void> => {
    if (sessionInitializationBusy || isProcessing) return;
    setIsProcessing(true);
    setSessionInitializationBusy(true);
    try {
      sessionInitializationRequestIdRef.current ??= crypto.randomUUID();
      const initResult = await initializeGameSession(
        { requestId: sessionInitializationRequestIdRef.current },
        firebaseGameSessionInitializationGateway
      );
      if (!initResult.ok) {
        toast.error(`Session初期化に失敗しました: ${initResult.reason}`);
        return;
      }
      sessionInitializationRequestIdRef.current = null;

      // 続いてミッションDB同期を実行
      const syncResult = await syncMissionCatalog(
        { requestId: crypto.randomUUID(), expectedSessionId: initResult.gameSessionId },
        firebaseAdminMissionGateway
      );
      if (syncResult.ok) {
        toast.success(`🎉 ゲーム準備が完了しました！\nセッションID: ${initResult.gameSessionId}\n公式ミッション${syncResult.createdCount}件を登録しました。参加者を招待してください。`);
      } else {
        toast.error(`セッションは初期化されましたが、ミッション同期に失敗しました: ${syncResult.reason}`);
      }
    } finally {
      setSessionInitializationBusy(false);
      setIsProcessing(false);
    }
  };

  const handleInitializeGameSession = async (): Promise<void> => {
    if (sessionInitializationBusy || isProcessing) return;
    sessionInitializationRequestIdRef.current ??= crypto.randomUUID();
    setSessionInitializationBusy(true);
    try {
      const result = await initializeGameSession({ requestId: sessionInitializationRequestIdRef.current }, firebaseGameSessionInitializationGateway);
      if (result.ok === false) {
        toast.error(`Session初期化に失敗しました: ${result.reason}`);
        return;
      }
      sessionInitializationRequestIdRef.current = null;
      if (result.alreadyInitialized) {
        toast.info(`Sessionは初期化済みです: ${result.gameSessionId}`);
      } else {
        toast.success(`Sessionを初期化しました: ${result.gameSessionId}`);
      }
    } finally {
      setSessionInitializationBusy(false);
    }
  };

  // 柔軟なフェーズ操作（1日・2日どちらでも自由進行）
  const handlePhaseAction = async (action: 'START_DAY1' | 'PAUSE' | 'RESUME' | 'END_DAY1' | 'START_DAY2' | 'START_FINAL' | 'END_GAME'): Promise<void> => {
    if (isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;

    const actionLabels: Record<string, string> = {
      START_DAY1: 'DAY 1（本戦）を開始',
      PAUSE: 'ゲームを一時中断',
      RESUME: 'ゲームを再開',
      END_DAY1: 'DAY 1 を終了（宿へ移動・翌日待機）',
      START_DAY2: 'DAY 2 を開始',
      START_FINAL: '🔥 クライマックス（最終ミッション）を開始',
      END_GAME: '🏁 ゲーム終了・結果発表',
    };

    if (!confirm(`フェーズ操作「${actionLabels[action] || action}」を実行しますか？`)) return;
    setIsProcessing(true);
    try {
      const result = await transitionGamePhase({ action, requestId: crypto.randomUUID(), expectedSessionId }, firebaseAdminPhaseGateway);
      if (result.ok === false) {
        toast.error(`フェーズ操作に失敗しました: ${result.reason}`);
      }
    } catch {
      toast.error('フェーズ操作に失敗しました');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleForceRoleSwap = async (): Promise<void> => {
    if (roleSwapBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    if (!confirm('Team A と Team B の役割（鬼・逃走者）を強制的に入れ替えますか？\n※新・鬼側は30分間の待機状態になります。')) return;

    roleSwapBusyRef.current = true;
    setIsProcessing(true);
    const requestId = roleSwapRequestIdRef.current ?? crypto.randomUUID();
    roleSwapRequestIdRef.current = requestId;
    try {
      const result = await swapTeamRoles({ requestId, expectedSessionId }, firebaseAdminGameStateGateway);
      if (result.ok === false) {
        toast.error('交代に失敗しました。通信状態を確認して再試行してください。');
        return;
      }
      roleSwapRequestIdRef.current = null;
      toast.success(`交代完了。Team ${result.newOniTeam} が鬼になりました。`);
    } finally {
      roleSwapBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleResumePlayer = async (user: User): Promise<void> => {
    if (resumeBusyRef.current.has(user.id)) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    if (!confirm(`${user.name} をすべての待機状態から復帰させますか？`)) return;

    resumeBusyRef.current.add(user.id);
    setResumingPlayerIds(new Set(resumeBusyRef.current));
    try {
      const result = await resumePlayer({ targetId: user.id, expectedSessionId }, firebaseAdminGameStateGateway);
      if (result.ok === false) {
        toast.error('Playerの復帰に失敗しました。権限と通信状態を確認してください。');
      } else {
        toast.success(`${user.name} を待機状態から復帰させました`);
      }
    } finally {
      resumeBusyRef.current.delete(user.id);
      setResumingPlayerIds(new Set(resumeBusyRef.current));
    }
  };

  const handleLocationReveal = async (scope: AdminRevealScope): Promise<void> => {
    if (revealBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    const target = scope === 'GLOBAL' ? '全員' : `Team ${scope === 'TEAM_A' ? 'A' : 'B'}`;
    if (!confirm(`${target}の最新位置を ${searchDuration} 分間、スナップショット公開しますか？`)) return;

    revealBusyRef.current = true;
    setIsProcessing(true);
    const requestId = revealRequestIdsRef.current[scope] ?? crypto.randomUUID();
    revealRequestIdsRef.current[scope] = requestId;
    try {
      const result = await revealPlayerLocations({ scope, durationMinutes: searchDuration, requestId, expectedSessionId }, firebaseAdminRevealGateway);
      if (result.ok === false) {
        toast.error(result.reason === 'ZERO_VALID_LOCATIONS'
          ? '最新の有効な位置情報がありません。Playerの位置更新後に再試行してください。'
          : '位置公開に失敗しました。権限と通信状態を確認して再試行してください。');
        return;
      }
      delete revealRequestIdsRef.current[scope];
      toast.success(`${result.duplicate ? '既に実行済みです。' : '公開しました。'}\n公開: ${result.projectedCount}名 / 除外: ${result.skippedCount}名`);
    } finally {
      revealBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleAdjustTeamScore = async (): Promise<void> => {
    if (scoreBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    const delta = Number(scoreDeltaInput);
    if (!Number.isSafeInteger(delta) || delta === 0 || delta < -1000 || delta > 1000) {
      toast.error('補正値は -1000〜1000 の0以外の整数で入力してください。');
      return;
    }
    const reasonLabels: Record<ScoreAdjustmentReasonCode, string> = {
      CORRECTION: 'スコア訂正', BONUS: '運営ボーナス', PENALTY: '運営ペナルティ', OTHER: 'その他の運営調整',
    };
    if (!confirm(`Team ${scoreTeam} を ${delta > 0 ? '+' : ''}${delta}pt 補正しますか？\n理由: ${reasonLabels[scoreReasonCode]}`)) return;
    const key = `${scoreTeam}:${delta}:${scoreReasonCode}`;
    const requestId = pendingScoreRequestRef.current?.key === key
      ? pendingScoreRequestRef.current.requestId
      : crypto.randomUUID();
    pendingScoreRequestRef.current = { key, requestId };
    scoreBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await adjustTeamScore({ team: scoreTeam, delta, reasonCode: scoreReasonCode, requestId, expectedSessionId }, firebaseAdminScoreAdjustmentGateway);
      if (result.ok === false) {
        toast.error(`スコア補正に失敗しました: ${result.reason}`);
        return;
      }
      pendingScoreRequestRef.current = null;
      setScoreAdjustmentResult(result);
      setScoreDeltaInput('');
      toast.success(`Team ${scoreTeam} を ${delta > 0 ? '+' : ''}${delta}pt 補正しました`);
    } finally {
      scoreBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const missionRequestId = (key: string): string => {
    missionRequestIdsRef.current[key] ??= crypto.randomUUID();
    return missionRequestIdsRef.current[key];
  };

  const handleToggleMissionMode = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    const pending = pendingMissionModeRef.current;
    const next = pending?.mode ?? (config.missionMode === 'SAME' ? 'DIFFERENT' : 'SAME');
    const requestId = pending?.requestId ?? crypto.randomUUID();
    pendingMissionModeRef.current ??= { mode: next, requestId };
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await setMissionMode({ mode: next, requestId, expectedSessionId }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        toast.error(`モード切り替えに失敗しました: ${result.reason}`);
        return;
      }
      pendingMissionModeRef.current = null;
      toast.success(`ミッションモードを ${next === 'SAME' ? '共通' : '個別'} に切り替えました`);
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleManualAssign = async (targetTeam: 'A' | 'B', targetMissionId?: string): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    const missionIdToAssign = targetMissionId || manualMissionId;
    if (!missionIdToAssign) {
      toast.error('ミッションを選択してください');
      return;
    }
    if (!confirm(`Team ${targetTeam} に指定ミッションを配信しますか？`)) return;

    const target = targetTeam === 'A' ? 'TEAM_A' : 'TEAM_B';
    const key = `manual:${target}:${missionIdToAssign}`;
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await assignMissions(
        { strategy: 'MANUAL', target, missionId: missionIdToAssign, requestId: missionRequestId(key), expectedSessionId },
        firebaseAdminMissionGateway
      );
      if (result.ok === false) {
        toast.error(`ミッション配信に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      toast.success(`Team ${targetTeam} へ配信完了`);
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleShuffleMissions = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    if (!confirm('ミッションをランダムに選定して両チームへ配信しますか？')) return;
    const key = 'random-assignment';
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await assignMissions({ strategy: 'RANDOM', target: 'BOTH', requestId: missionRequestId(key), expectedSessionId }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        toast.error(`ランダム配信に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      toast.success('ランダムミッションを配信しました');
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleSyncMissionCatalog = async (): Promise<void> => {
    if (missionBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || !confirm('36件の標準ミッションをFirestoreに同期・初期登録しますか？')) return;
    const key = 'catalog-sync';
    missionBusyRef.current = true;
    setIsProcessing(true);
    try {
      const result = await syncMissionCatalog({ requestId: missionRequestId(key), expectedSessionId }, firebaseAdminMissionGateway);
      if (result.ok === false) {
        toast.error(`ミッションcatalog同期に失敗しました: ${result.reason}`);
        return;
      }
      delete missionRequestIdsRef.current[key];
      toast.success(`同期完了: ${result.totalManagedCount}件のミッションを反映しました`);
    } finally {
      missionBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  // ノーコードミッション保存（新規作成 / 編集）
  const handleSaveCustomMission = async (mission: Mission): Promise<void> => {
    try {
      await createOrUpdateMission(mission);
      setIsMissionModalOpen(false);
      setEditingMission(null);
      toast.success(`ミッション「${mission.title}」を保存しました`);
    } catch (err) {
      console.error('Error saving mission:', err);
      toast.error('ミッションの保存に失敗しました');
    }
  };

  // ミッション削除
  const handleDeleteMission = async (mission: Mission): Promise<void> => {
    if (!confirm(`ミッション「${mission.title}」を削除しますか？`)) return;
    try {
      await deleteMission(mission.id);
      toast.success('削除しました');
    } catch (err) {
      console.error('Error deleting mission:', err);
      toast.error('ミッションの削除に失敗しました');
    }
  };

  // 管理者手動達成承認
  const handleAdminAwardMission = async (): Promise<void> => {
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || !manualAwardMissionId) {
      toast.error('ミッションを選択してください');
      return;
    }
    const targetMission = allMissionsList.find(m => m.id === manualAwardMissionId);
    if (!targetMission) return;

    if (!confirm(`Team ${manualAwardTeam} のミッション「${targetMission.title}」達成を承認し、+${targetMission.points}pt 加算しますか？`)) return;

    setIsProcessing(true);
    try {
      const success = await awardMissionCompletionByAdmin({
        team: manualAwardTeam,
        missionId: targetMission.id,
        title: targetMission.title,
        points: targetMission.points,
        expectedSessionId,
      });
      if (success) {
        toast.success(`Team ${manualAwardTeam} に +${targetMission.points}pt 加算しました！`);
        setManualAwardMissionId('');
      } else {
        toast.error('加算処理に失敗しました（既に達成承認済みの可能性があります）');
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // 全体一斉通知（ブロードキャスト）送信
  const handleSendBroadcast = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const msg = broadcastInput.trim();
    if (!msg) {
      toast.error('メッセージを入力してください');
      return;
    }
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;

    setIsSendingBroadcast(true);
    try {
      const ok = await sendAdminBroadcast(msg, expectedSessionId);
      if (ok) {
        toast.success('全体一斉通知を送信しました');
        setBroadcastInput('');
      } else {
        toast.error('全体一斉通知の送信に失敗しました');
      }
    } catch (err) {
      console.error('Error sending broadcast:', err);
      toast.error('全体一斉通知の送信中にエラーが発生しました');
    } finally {
      setIsSendingBroadcast(false);
    }
  };

  // 汎用ルール可変設定の保存
  const handleSaveRuleSettings = async (): Promise<void> => {
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || isSavingRules) return;

    setIsSavingRules(true);
    try {
      const result = await updateAdminRuleSettings(
        {
          victoryMode: ruleVictoryMode,
          shinkansenMaxMinutes: ruleShinkansenMaxMinutes,
          shinkansenMaxSegments: ruleShinkansenMaxSegments,
          postShinkansenWaitMinutes: rulePostShinkansenWaitMinutes,
          periodicRevealIntervalMinutes: rulePeriodicRevealIntervalMinutes,
          periodicRevealDurationMinutes: rulePeriodicRevealDurationMinutes,
          captureWaitMinutes: ruleCaptureWaitMinutes,
          missionPenaltyRevealMinutes: ruleMissionPenaltyRevealMinutes,
        },
        expectedSessionId,
      );

      if (result.ok) {
        toast.success('ルール設定を更新しました！参加者にリアルタイム反映されます。');
      } else {
        toast.error(`ルール設定の更新に失敗しました: ${result.reason}`);
      }
    } catch (error) {
      console.error('Error saving rule settings:', error);
      toast.error('ルール設定の更新中にエラーが発生しました');
    } finally {
      setIsSavingRules(false);
    }
  };

  // ミッション違反・ルール違反ペナルティ位置開示の発動
  const handleApplyPenalty = async (): Promise<void> => {
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || !penaltyTargetPlayerId || isApplyingPenalty) return;

    const targetUser = users.find(u => u.id === penaltyTargetPlayerId);
    if (!targetUser) {
      toast.error('対象プレイヤーが見つかりません');
      return;
    }

    if (!confirm(`プレイヤー「${targetUser.name}」に${penaltyDurationMinutes}分間のペナルティ（位置常時開示）を発動しますか？`)) {
      return;
    }

    setIsApplyingPenalty(true);
    try {
      const result = await applyAdminPenaltyReveal(
        penaltyTargetPlayerId,
        penaltyDurationMinutes,
        expectedSessionId,
      );

      if (result.ok) {
        toast.success(`🚨 ${targetUser.name} に${penaltyDurationMinutes}分間のペナルティ位置開示を発動しました！`);
      } else {
        toast.error(`ペナルティ発動に失敗しました: ${result.reason}`);
      }
    } catch (error) {
      console.error('Error applying penalty:', error);
      toast.error('ペナルティ発動中にエラーが発生しました');
    } finally {
      setIsApplyingPenalty(false);
    }
  };

  // プレイヤーチーム変更
  const handleChangePlayerTeam = async (user: User): Promise<void> => {
    const nextTeam = user.team === 'A' ? 'B' : 'A';
    if (!confirm(`${user.name} のチームを TEAM ${nextTeam} に変更しますか？`)) return;
    setModifyingPlayerIds(prev => new Set(prev).add(user.id));
    try {
      await adminChangePlayerTeam(user.id, nextTeam);
      toast.success(`${user.name} を TEAM ${nextTeam} に変更しました`);
    } catch (err) {
      console.error('Change team error:', err);
      toast.error('チーム変更に失敗しました');
    } finally {
      setModifyingPlayerIds(prev => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  };

  // プレイヤー削除
  const handleDeletePlayer = async (user: User): Promise<void> => {
    if (!confirm(`本当にプレイヤー「${user.name}」を削除しますか？\n（位置情報や参加データも同時に削除されます）`)) return;
    setModifyingPlayerIds(prev => new Set(prev).add(user.id));
    try {
      await adminDeletePlayer(user.id);
      toast.success(`プレイヤー「${user.name}」を削除しました`);
    } catch (err) {
      console.error('Delete player error:', err);
      toast.error('プレイヤー削除に失敗しました');
    } finally {
      setModifyingPlayerIds(prev => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  };

  const handlePrepareGameReset = async (): Promise<void> => {
    if (resetBusyRef.current || isProcessing) return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    resetBusyRef.current = true;
    setIsProcessing(true);
    setResetPreview(null);
    setResetConfirmationText('');
    setResetError(null);
    setResetSuccess(null);
    resetRequestIdRef.current = null;
    try {
      const result = await prepareGameReset({ expectedSessionId }, firebaseAdminGameResetGateway);
      if (result.ok === false) {
        setResetError(`Reset Previewに失敗しました: ${result.reason}`);
        return;
      }
      setResetPreview(result.preview);
    } finally {
      resetBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleExecuteGameReset = async (): Promise<void> => {
    if (resetBusyRef.current || isProcessing || !resetPreview || resetConfirmationText !== 'RESET') return;
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId) return;
    if (expectedSessionId !== resetPreview.currentSessionId) {
      setResetError('PreviewのSessionが現在のSessionと一致しません: SESSION_CHANGED');
      return;
    }
    resetBusyRef.current = true;
    setIsProcessing(true);
    setResetError(null);
    try {
      resetRequestIdRef.current ??= crypto.randomUUID();
      const result = await executeGameReset({
        confirmationToken: resetPreview.confirmationToken,
        requestId: resetRequestIdRef.current,
        expectedSessionId,
      }, firebaseAdminGameResetGateway);
      if (result.ok === false) {
        setResetError(`Resetは実行されませんでした: ${result.reason}`);
        return;
      }
      resetRequestIdRef.current = null;
      setResetSuccess(`新しいSession ${result.newSessionId} を開始しました`);
    } finally {
      resetBusyRef.current = false;
      setIsProcessing(false);
    }
  };

  // 招待URLコピー
  const handleCopyInviteUrl = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  // 招待メッセージコピー
  const handleCopyInviteMessage = async () => {
    if (!inviteUrl) return;
    const msg = `🚆【鉄道鬼ごっこ】ゲームに参加しよう！\nインストール不要！以下のURLを開き、お好きなユーザーIDとパスワードで参加してね：\n${inviteUrl}`;
    await navigator.clipboard.writeText(msg);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2500);
  };

  // ミッション一覧（Firestoreのmissionsを最優先、空ならconstantsのMISSIONS）
  const allMissionsList = useMemo(() => {
    return missions.length > 0 ? missions : MISSIONS;
  }, [missions]);

  const currentMissionA = allMissionsList.find(m => m.id === config.activeMissionA);
  const currentMissionB = allMissionsList.find(m => m.id === config.activeMissionB);

  // フィルタ済みミッション
  const filteredMissions = useMemo(() => {
    if (!missionSearch.trim()) return allMissionsList;
    const q = missionSearch.toLowerCase();
    return allMissionsList.filter(m => m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
  }, [allMissionsList, missionSearch]);

  // 人間向けフェーズラベル
  const phaseLabel = useMemo(() => {
    switch (config.gameStatus) {
      case 'PRE_GAME': return '⚪ 準備中（プレイヤー参加受付）';
      case 'DAY1_ACTIVE': return '🟢 DAY 1 進行中';
      case 'DAY1_PAUSED': return '🟡 DAY 1 一時停止中';
      case 'DAY1_ENDED': return '🌙 DAY 1 終了（宿泊・翌日待機）';
      case 'DAY2_ACTIVE': return '🟢 DAY 2 進行中';
      case 'DAY2_PAUSED': return '🟡 DAY 2 一時停止中';
      case 'FINAL_MISSION': return '🔥 最終ミッション（クライマックス）';
      case 'GAME_OVER': return '🏁 ゲーム終了・結果発表';
      default: return config.gameStatus;
    }
  }, [config.gameStatus]);

  // ログイン前の画面（メール不要のユーザーID・パスワード）
  if (!isAuthorized) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 p-4 font-sans text-white">
        {isFirebaseMisconfigured && (
          <div className="w-full max-w-sm mb-4 p-4 bg-red-600/90 border-2 border-red-400 text-white rounded-2xl text-xs font-bold shadow-2xl flex items-start gap-2.5">
            <AlertTriangle size={20} className="shrink-0 text-amber-300 mt-0.5" />
            <div>
              <div className="font-black text-amber-200 mb-0.5">Firebase環境設定エラー</div>
              ⚠️ Firebaseの環境変数（.env）が設定されないままビルドされています。プロジェクトルートの .env ファイルに VITE_FIREBASE_API_KEY 等を設定し、再度 npm run build && npx firebase deploy を実行してください。
            </div>
          </div>
        )}

        <div className="w-full max-w-sm bg-slate-800 p-8 rounded-3xl text-center shadow-2xl border border-slate-700 relative overflow-hidden">
          <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
            <Lock size={32} className="text-blue-400" />
          </div>
          <h2 className="text-2xl font-black mb-1">
            {isSetupMode ? '初回管理者登録' : '管理者ログイン'}
          </h2>
          <p className="text-xs text-slate-400 font-medium mb-6">
            {isSetupMode
              ? '初回1回限りの管理者アカウントを作成します'
              : 'メールアドレス不要・IDとパスワードで管理画面へ'}
          </p>

          {authError && (
            <div className="mb-4 p-3 bg-red-500/20 border border-red-500/40 text-red-300 rounded-xl text-xs font-bold text-left">
              {authError}
            </div>
          )}

          {!isSetupMode ? (
            <form onSubmit={async e => {
              e.preventDefault();
              setAuthError(null);
              try {
                const authorized = await signInAdmin(adminIdInput, passwordInput);
                if (!authorized) {
                  setAuthError('管理者権限が確認できませんでした。IDとパスワードをご確認ください。');
                  return;
                }
                setIsAuthorized(true);
              } catch (err: unknown) {
                const code = (err as { code?: string })?.code || '';
                if (code === 'auth/operation-not-allowed') {
                  setAuthError('⚠️ Firebase Console の「Authentication > ログイン方法」で「メール/パスワード」が有効になっていません。Firebase Console で有効化してください。');
                } else if (code === 'auth/invalid-api-key' || code.includes('api-key-not-valid')) {
                  setAuthError('⚠️ Firebase APIキーが正しくありません。.env の VITE_FIREBASE_API_KEY を確認してください。');
                } else if (code === 'permission-denied') {
                  setAuthError('⚠️ Firestore セキュリティルールによって拒否されました。npx firebase deploy --only firestore:rules を実行したか確認してください。');
                } else {
                  setAuthError('ログインに失敗しました。IDまたはパスワードをご確認ください。');
                }
              }
            }}>
              <div className="text-left mb-3">
                <label htmlFor="admin-id" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                  管理者ID
                </label>
                <input
                  id="admin-id"
                  type="text"
                  value={adminIdInput}
                  onChange={e => setAdminIdInput(e.target.value)}
                  className="w-full p-3.5 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                  placeholder="例: admin"
                  required
                />
              </div>

              <div className="text-left mb-5">
                <label htmlFor="admin-pass" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                  パスワード
                </label>
                <input
                  id="admin-pass"
                  type="password"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  className="w-full p-3.5 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                  placeholder="パスワード"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black shadow-lg transition-all active:scale-95 text-sm"
              >
                ログインする
              </button>

              <div className="mt-5 pt-4 border-t border-slate-700 flex flex-col gap-2">
                {isBootstrapCompleted === false && (
                  <button
                    type="button"
                    onClick={() => { setIsSetupMode(true); setAuthError(null); }}
                    className="text-xs font-bold text-emerald-400 hover:text-emerald-300"
                  >
                    初めての方はこちら（初期管理者登録）
                  </button>
                )}
                <Link to="/" className="text-xs font-medium text-slate-500 hover:text-slate-400">
                  ← プレイヤー参加画面へ戻る
                </Link>
              </div>
            </form>
          ) : (
            <form onSubmit={async e => {
              e.preventDefault();
              setAuthError(null);
              if (passwordInput.length < 8) {
                setAuthError('管理者パスワードは8文字以上で設定してください。');
                return;
              }
              try {
                await setupInitialAdmin(adminIdInput, passwordInput);
                setIsAuthorized(true);
                setIsBootstrapCompleted(true);
                toast.success('管理者アカウントを作成し、ログインしました！');
              } catch (err: unknown) {
                console.error('Setup error:', err);
                const msg = (err as Error)?.message;
                const code = (err as { code?: string })?.code || '';
                if (msg === 'ADMIN_ALREADY_INITIALIZED') {
                  setAuthError('初期管理者は既に登録済みです。登録したIDとパスワードでログインしてください。');
                  setIsSetupMode(false);
                } else if (msg === 'ADMIN_PASSWORD_TOO_SHORT') {
                  setAuthError('管理者パスワードは8文字以上で設定してください。');
                } else if (code === 'auth/operation-not-allowed') {
                  setAuthError('⚠️ Firebase Console の「Authentication > ログイン方法」で「メール/パスワード」が有効になっていません。Firebase Console で有効化してください。');
                } else if (code === 'auth/invalid-api-key' || code.includes('api-key-not-valid')) {
                  setAuthError('⚠️ Firebase APIキーが正しくありません。.env の VITE_FIREBASE_API_KEY を確認してください。');
                } else if (code === 'permission-denied') {
                  setAuthError('⚠️ Firestore セキュリティルールによって拒否されました。npx firebase deploy --only firestore:rules を実行したか確認してください。');
                } else {
                  setAuthError('管理者登録に失敗しました。');
                }
              }
            }}>
              <div className="text-left mb-3">
                <label htmlFor="setup-admin-id" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                  希望する管理者ID
                </label>
                <input
                  id="setup-admin-id"
                  type="text"
                  value={adminIdInput}
                  onChange={e => setAdminIdInput(e.target.value)}
                  className="w-full p-3 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                  placeholder="例: admin"
                  required
                />
              </div>

              <div className="text-left mb-5">
                <label htmlFor="setup-password" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">
                  管理者パスワード（8文字以上）
                </label>
                <input
                  id="setup-password"
                  type="password"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  className="w-full p-3 bg-slate-700/80 rounded-xl text-white font-bold outline-none border-2 border-transparent focus:border-blue-500 text-sm"
                  placeholder="8文字以上の強力なパスワード"
                  minLength={8}
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black shadow-lg transition-all active:scale-95 text-sm"
              >
                管理者アカウントを作成（初回限定）
              </button>

              <div className="mt-4 pt-3 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => { setIsSetupMode(false); setAuthError(null); }}
                  className="text-xs font-bold text-slate-400 hover:text-white"
                >
                  ← 既存アカウントでログイン
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ログイン後の管理者ダッシュボード
  return (
    <div className="p-4 pb-36 space-y-6 text-slate-800 bg-slate-100 min-h-screen font-sans">
      {/* トップヘッダー */}
      <header className="flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h1 className="text-lg font-black text-slate-900 flex items-center gap-2">
            <Shield size={20} className="text-blue-600" />
            運営管理ダッシュボード
          </h1>
          <p className="text-xs text-slate-500 font-medium">
            セッション: {config.gameSessionId ? `${config.gameSessionId.slice(0, 12)}...` : '未初期化'}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/map"
            className="px-3 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200 flex items-center gap-1.5 transition-colors"
          >
            <MapPin size={14} /> マップへ
          </Link>
          <button
            type="button"
            onClick={() => setShowQrModal(true)}
            className="px-3 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 flex items-center gap-1.5 shadow-sm transition-all"
          >
            <QrCode size={14} /> 招待QR
          </button>
        </div>
      </header>

      {/* 🌟 1. かんたん初期化ウィザード */}
      {!config.gameSessionId ? (
        <section className="bg-gradient-to-r from-blue-600 to-indigo-700 p-6 rounded-3xl shadow-xl text-white">
          <div className="flex items-center gap-2 text-blue-200 text-xs font-black uppercase tracking-wider mb-2">
            <Sparkles size={16} /> First Time Setup
          </div>
          <h2 className="text-xl font-black mb-2">1クリック初期セットアップ</h2>
          <p className="text-xs text-blue-100 leading-relaxed mb-5">
            プログラミングやデータベース操作は一切不要です。<br />
            下のボタンを押すと、ゲームセッションの発行と公式ミッション（36件）の登録が一括で完了します。
          </p>
          <button
            type="button"
            onClick={handleQuickSetupWizard}
            disabled={sessionInitializationBusy || isProcessing}
            className="w-full py-4 bg-white text-blue-800 rounded-2xl font-black text-sm shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
          >
            <Sparkles size={18} className="text-amber-500" />
            {sessionInitializationBusy ? 'セットアップ実行中...' : '🚀 1クリックでゲームを一括初期化する'}
          </button>
        </section>
      ) : (
        <section className="rounded-2xl border-2 border-blue-100 bg-white p-4 shadow-sm flex justify-between items-center">
          <div>
            <h3 className="font-black text-xs text-slate-800">Game Session 状態</h3>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{config.gameSessionId}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleInitializeGameSession()}
            disabled={sessionInitializationBusy || isProcessing}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold"
          >
            状態確認
          </button>
        </section>
      )}

      {/* 📱 2. プレイヤー招待パネル */}
      <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase">
            <Users size={18} className="text-blue-600" />
            参加者の招待（{users.length}名 登録中）
          </h3>
          <span className="text-[10px] font-black px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">
            A: {users.filter(u => u.team === 'A').length}名 / B: {users.filter(u => u.team === 'B').length}名
          </span>
        </div>

        <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200 mb-3">
          <input
            type="text"
            readOnly
            value={inviteUrl}
            className="flex-1 bg-transparent text-xs font-bold text-slate-600 outline-none truncate"
          />
          <button
            type="button"
            onClick={handleCopyInviteUrl}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-black flex items-center gap-1 active:scale-95"
          >
            {copiedLink ? <Check size={14} /> : <Copy size={14} />}
            {copiedLink ? 'コピー完了' : 'URLコピー'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleCopyInviteMessage}
            className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
          >
            <Copy size={14} />
            {copiedText ? '案内文をコピー済' : 'LINE用案内文をコピー'}
          </button>
          <button
            type="button"
            onClick={() => setShowQrModal(true)}
            className="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
          >
            <QrCode size={14} />
            QRコードを拡大表示
          </button>
        </div>
      </section>

      {/* 🎮 3. フェーズ管理（1日・2日どちらでも自由進行） */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-black flex items-center gap-2 text-slate-800 uppercase tracking-tight text-sm">
            <Play size={18} className="text-blue-600" />
            進行コントロール
          </h3>
          <span className="text-xs font-black px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
            {phaseLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {config.gameStatus === 'PRE_GAME' && (
            <button
              type="button"
              onClick={() => handlePhaseAction('START_DAY1')}
              disabled={isProcessing}
              className="col-span-2 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-black text-sm shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all"
            >
              <Play size={18} /> DAY 1（ゲーム本戦）を開始する
            </button>
          )}

          {config.gameStatus === 'DAY1_ACTIVE' && (
            <>
              <button type="button" onClick={() => handlePhaseAction('PAUSE')} disabled={isProcessing} className="p-3.5 rounded-xl font-black text-xs bg-slate-100 text-slate-700 hover:bg-slate-200">
                ⏸ 一時停止
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_DAY1')} disabled={isProcessing} className="p-3.5 rounded-xl font-black text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200">
                🌙 DAY 1 終了（宿へ）
              </button>
              <button type="button" onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="col-span-2 py-3.5 bg-gradient-to-r from-red-600 to-amber-600 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5">
                🔥 最終ミッション開始（1日制クライマックス）
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="col-span-2 py-2.5 bg-slate-800 text-white rounded-xl font-bold text-xs">
                🏁 ゲーム終了・結果発表へ
              </button>
            </>
          )}

          {config.gameStatus === 'DAY1_PAUSED' && (
            <>
              <button type="button" onClick={() => handlePhaseAction('RESUME')} disabled={isProcessing} className="col-span-2 py-3.5 bg-emerald-600 text-white rounded-xl font-black text-xs shadow-md">
                ▶ DAY 1 を再開する
              </button>
              <button type="button" onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-bold text-xs">
                🔥 最終ミッションへ
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
                🏁 結果発表へ
              </button>
            </>
          )}

          {config.gameStatus === 'DAY1_ENDED' && (
            <>
              <button type="button" onClick={() => handlePhaseAction('START_DAY2')} disabled={isProcessing} className="col-span-2 py-3.5 bg-blue-600 text-white rounded-2xl font-black text-sm shadow-md">
                ☀️ DAY 2 を開始する（2日目）
              </button>
              <button type="button" onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-black text-xs">
                🔥 最終ミッションを実施
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
                🏁 ゲーム終了（結果発表）
              </button>
            </>
          )}

          {config.gameStatus === 'DAY2_ACTIVE' && (
            <>
              <button type="button" onClick={() => handlePhaseAction('PAUSE')} disabled={isProcessing} className="p-3 rounded-xl font-bold text-xs bg-slate-100 text-slate-700">
                ⏸ 一時停止
              </button>
              <button type="button" onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-black text-xs shadow-md">
                🔥 最終ミッション開始
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="col-span-2 py-2.5 bg-slate-800 text-white rounded-xl font-bold text-xs">
                🏁 結果発表へ
              </button>
            </>
          )}

          {config.gameStatus === 'DAY2_PAUSED' && (
            <>
              <button type="button" onClick={() => handlePhaseAction('RESUME')} disabled={isProcessing} className="col-span-2 py-3 bg-blue-600 text-white rounded-xl font-black text-xs">
                ▶ DAY 2 再開
              </button>
              <button type="button" onClick={() => handlePhaseAction('START_FINAL')} disabled={isProcessing} className="p-3 bg-red-600 text-white rounded-xl font-bold text-xs">
                🔥 最終ミッションへ
              </button>
              <button type="button" onClick={() => handlePhaseAction('END_GAME')} disabled={isProcessing} className="p-3 bg-slate-800 text-white rounded-xl font-bold text-xs">
                🏁 結果発表へ
              </button>
            </>
          )}

          {config.gameStatus === 'FINAL_MISSION' && (
            <button
              type="button"
              onClick={() => handlePhaseAction('END_GAME')}
              disabled={isProcessing}
              className="col-span-2 py-4 bg-red-600 text-white rounded-2xl font-black text-sm shadow-xl active:scale-95"
            >
              🏁 全工程終了・結果発表を表示
            </button>
          )}

          {config.gameStatus === 'GAME_OVER' && (
            <div className="col-span-2 p-3 bg-slate-100 rounded-xl text-center text-xs font-bold text-slate-600">
              全行程終了済み。下部のマスターリセットから新しいセッションを開始できます。
            </div>
          )}
        </div>
      </section>

      {/* ⚙️ 4. 広域交通鬼ごっこ ルール規定設定（リアルタイム可変） */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="font-black flex items-center gap-2 text-slate-800 uppercase tracking-tight text-sm">
              <Sliders size={18} className="text-indigo-600" />
              広域交通鬼ごっこ ルール規定設定（リアルタイム可変）
            </h3>
            <p className="text-xs text-slate-500 font-medium mt-1">
              各「◯」の数値はゲーム進行中も即座に変更・全体配信可能です。
            </p>
          </div>
          <span className={`text-xs font-black px-3 py-1 rounded-full self-start sm:self-auto ${
            ruleVictoryMode === 'SURVIVAL' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-purple-50 text-purple-700 border border-purple-200'
          }`}>
            {ruleVictoryMode === 'SURVIVAL' ? '🏃‍♂️ サバイバル制' : '🏆 ポイント交代制'}
          </span>
        </div>

        <div className="space-y-4">
          {/* 勝敗条件セレクター */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
            <div className="text-xs font-black text-slate-700 block mb-2">
              1. 勝敗条件（ゲームモード）
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRuleVictoryMode('SURVIVAL')}
                className={`p-3 rounded-xl text-left border transition-all ${
                  ruleVictoryMode === 'SURVIVAL'
                    ? 'bg-emerald-500 text-white border-emerald-600 shadow-md font-black'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 font-bold'
                }`}
              >
                <div className="text-xs">🏃‍♂️ サバイバル制</div>
                <div className={`text-[10px] mt-0.5 ${ruleVictoryMode === 'SURVIVAL' ? 'text-emerald-100' : 'text-slate-500'}`}>
                  逃走者: タイムアップ生存で勝利<br />鬼: 全逃走者確保で即勝利
                </div>
              </button>
              <button
                type="button"
                onClick={() => setRuleVictoryMode('SCORE_SWAP')}
                className={`p-3 rounded-xl text-left border transition-all ${
                  ruleVictoryMode === 'SCORE_SWAP'
                    ? 'bg-purple-600 text-white border-purple-700 shadow-md font-black'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 font-bold'
                }`}
              >
                <div className="text-xs">🏆 ポイント交代制</div>
                <div className={`text-[10px] mt-0.5 ${ruleVictoryMode === 'SCORE_SWAP' ? 'text-purple-100' : 'text-slate-500'}`}>
                  攻守交代しながら獲得スコアと確保ボーナスで勝敗を競う
                </div>
              </button>
            </div>
          </div>

          {/* 新幹線・特急等利用制限 */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
            <h4 className="text-xs font-black text-slate-700">
              🚄 2. 新幹線・特急利用制限（バランス調整）
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>最長連続乗車（分） <span className="text-[10px] text-slate-400 ml-1">0=無制限</span></span>
                  <input
                    type="number"
                    min={0}
                    max={360}
                    step={10}
                    value={ruleShinkansenMaxMinutes}
                    onChange={e => setRuleShinkansenMaxMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>最長連続区間（区間） <span className="text-[10px] text-slate-400 ml-1">0=無制限</span></span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={ruleShinkansenMaxSegments}
                    onChange={e => setRuleShinkansenMaxSegments(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>下車後待機義務（分）</span>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    step={5}
                    value={rulePostShinkansenWaitMinutes}
                    onChange={e => setRulePostShinkansenWaitMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* 位置情報開示＆ペナルティ設定 */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
            <h4 className="text-xs font-black text-slate-700">
              📍 3. 位置開示・確保・ペナルティ設定
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>定期開示 間隔（分ごと）</span>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    step={5}
                    value={rulePeriodicRevealIntervalMinutes}
                    onChange={e => setRulePeriodicRevealIntervalMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>定期開示 継続時間（分間）</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={rulePeriodicRevealDurationMinutes}
                    onChange={e => setRulePeriodicRevealDurationMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>確保後 待機時間（分間）</span>
                  <input
                    type="number"
                    min={5}
                    max={120}
                    step={5}
                    value={ruleCaptureWaitMinutes}
                    onChange={e => setRuleCaptureWaitMinutes(Math.max(5, parseInt(e.target.value, 10) || 5))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 block mb-1">
                  <span>ペナルティ常時開示（分間）</span>
                  <input
                    type="number"
                    min={1}
                    max={180}
                    step={5}
                    value={ruleMissionPenaltyRevealMinutes}
                    onChange={e => setRuleMissionPenaltyRevealMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full p-2 text-xs bg-white border border-slate-200 rounded-xl font-bold mt-1"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* 保存ボタン */}
          <button
            type="button"
            onClick={handleSaveRuleSettings}
            disabled={isSavingRules}
            className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-black text-sm shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
          >
            <Sliders size={16} />
            {isSavingRules ? 'ルール設定を保存中...' : '⚙️ ルール規定設定を保存・全参加者へ即時反映'}
          </button>
        </div>
      </section>

      {/* 📢 参加者全員へ一斉通知（ブロードキャスト） */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-2 text-slate-800 uppercase tracking-tight text-sm">
          <Megaphone size={18} className="text-amber-500" />
          参加者全員へ一斉通知（ブロードキャスト）
        </h3>
        <p className="text-xs text-slate-500 font-medium mb-3">
          全プレイヤーの画面にトースト通知を一斉表示し、タイムラインログに記録します。
        </p>
        <form onSubmit={handleSendBroadcast} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={broadcastInput}
            onChange={e => setBroadcastInput(e.target.value)}
            maxLength={200}
            placeholder="例: 14:00から中間ボーナスミッション開始！"
            className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none focus:border-blue-500"
            disabled={isSendingBroadcast}
          />
          <button
            type="submit"
            disabled={isSendingBroadcast || !broadcastInput.trim()}
            className="py-3 px-5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5 shrink-0 transition-all active:scale-95"
          >
            <Send size={14} /> 一斉送信
          </button>
        </form>
      </section>

      {/* 🔄 4. 攻守交代 */}
      <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-3 text-slate-700 text-sm uppercase">
          <RefreshCw size={18} className="text-slate-700" />
          攻守管理（鬼・逃走者）
        </h3>
        <div className="flex justify-between items-center px-4 py-2.5 bg-slate-50 rounded-2xl border border-slate-100 mb-3">
          <div className="text-[10px] font-black text-slate-500 uppercase">現在ステータス</div>
          <div className="flex gap-2 font-black text-xs">
            <span className={config.teamARole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>
              Team A: {config.teamARole === 'ONI' ? '👹 鬼' : '🏃 逃走者'}
            </span>
            <span className="text-slate-300">/</span>
            <span className={config.teamBRole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>
              Team B: {config.teamBRole === 'ONI' ? '👹 鬼' : '🏃 逃走者'}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleForceRoleSwap}
          disabled={isProcessing}
          className="w-full py-3 bg-slate-900 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all"
        >
          <RefreshCw size={16} /> 攻守を強制交代する（30分待機付与）
        </button>
      </section>

      {/* 🎯 5. ノーコード・ミッション管理センター */}
      <section className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-black flex items-center gap-2 text-slate-900 text-sm uppercase">
            <Shuffle size={18} className="text-indigo-600" />
            ミッション管理センター
          </h3>
          <button
            type="button"
            onClick={() => { setEditingMission(null); setIsMissionModalOpen(true); }}
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-black flex items-center gap-1 shadow-sm active:scale-95"
          >
            <Plus size={14} /> 新規作成
          </button>
        </div>

        {/* タブ切り替え */}
        <div className="grid grid-cols-3 p-1 bg-slate-100 rounded-2xl mb-4 text-xs font-black">
          <button
            type="button"
            onClick={() => setMissionTab('DISPATCH')}
            className={`py-2 rounded-xl transition-all ${
              missionTab === 'DISPATCH' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            🎮 配信中
          </button>
          <button
            type="button"
            onClick={() => setMissionTab('CATALOG')}
            className={`py-2 rounded-xl transition-all ${
              missionTab === 'CATALOG' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            📋 一覧（{allMissionsList.length}）
          </button>
          <button
            type="button"
            onClick={() => setMissionTab('COMPLETIONS')}
            className={`py-2 rounded-xl transition-all ${
              missionTab === 'COMPLETIONS' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            🏆 達成承認（{liveCompletions.length}）
          </button>
        </div>

        {/* タブ1: 配信コントロール */}
        {missionTab === 'DISPATCH' && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={handleToggleMissionMode}
              disabled={isProcessing}
              className="w-full py-2.5 rounded-xl border border-indigo-200 text-xs font-black flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 active:bg-indigo-100"
            >
              配信モード：{config.missionMode === 'SAME' ? '🔗 両チーム同一' : '🔀 チーム別'}
            </button>

            {/* A・Bチーム配信状況カード */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(['A', 'B'] as const).map(t => {
                const m = t === 'A' ? currentMissionA : currentMissionB;
                return (
                  <div key={t} className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                    <div className="flex justify-between items-center mb-1">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                        t === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                      }`}>
                        Team {t} 配信中
                      </span>
                      {m && <span className="text-xs font-black text-indigo-600">+{m.points}pt</span>}
                    </div>
                    <h4 className="font-black text-slate-800 text-sm mb-1">{m ? m.title : '未配信'}</h4>
                    <p className="text-[11px] text-slate-500 line-clamp-2 mb-3">
                      {m ? m.description : 'ミッションを選択して配信してください'}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleManualAssign(t)}
                        disabled={isProcessing || !manualMissionId}
                        className="flex-1 py-1.5 bg-slate-900 text-white rounded-lg text-[10px] font-bold disabled:opacity-40"
                      >
                        指定ミッションを配信
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 手動指定配信セレクター */}
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <label htmlFor="assign-mission-select" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                手動配信用のミッションを選択
              </label>
              <select
                id="assign-mission-select"
                value={manualMissionId}
                onChange={e => setManualMissionId(e.target.value)}
                className="w-full p-2 bg-white rounded-lg border border-slate-200 text-xs font-bold text-slate-800 mb-2 truncate"
              >
                <option value="">ミッションを選択してください...</option>
                {allMissionsList.map(m => (
                  <option key={m.id} value={m.id}>[{m.points}pt] {m.title}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleManualAssign('A')}
                  disabled={isProcessing || !manualMissionId}
                  className="py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-xs font-black disabled:opacity-40"
                >
                  Team A に配信
                </button>
                <button
                  type="button"
                  onClick={() => handleManualAssign('B')}
                  disabled={isProcessing || !manualMissionId}
                  className="py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-black disabled:opacity-40"
                >
                  Team B に配信
                </button>
              </div>
            </div>

            {/* 一括ランダム・同期 */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={handleShuffleMissions}
                disabled={isProcessing}
                className="py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-1.5"
              >
                <Shuffle size={14} /> 🎲 ランダム再選定
              </button>
              <button
                type="button"
                onClick={handleSyncMissionCatalog}
                disabled={isProcessing}
                className="py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs"
              >
                🔄 公式36件を再同期
              </button>
            </div>
          </div>
        )}

        {/* タブ2: ミッション一覧・作成・編集 */}
        {missionTab === 'CATALOG' && (
          <div className="space-y-3">
            <input
              type="text"
              value={missionSearch}
              onChange={e => setMissionSearch(e.target.value)}
              placeholder="ミッション名やキーワードで検索..."
              className="w-full px-3.5 py-2.5 bg-slate-50 rounded-xl border border-slate-200 text-xs font-bold outline-none focus:border-indigo-500"
            />

            <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
              {filteredMissions.map(m => (
                <div key={m.id} className="p-3 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col gap-2">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                          {m.points}pt
                        </span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                          {m.type === 'PHOTO' ? '📸 写真' : '📍 駅チェックイン'}
                        </span>
                      </div>
                      <h4 className="text-xs font-black text-slate-900 leading-snug">{m.title}</h4>
                      <p className="text-[10px] text-slate-500 line-clamp-2 mt-0.5">{m.description}</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => { setEditingMission(m); setIsMissionModalOpen(true); }}
                        className="p-1.5 text-slate-500 hover:text-slate-900 bg-white rounded-lg border border-slate-200"
                        title="編集"
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteMission(m)}
                        className="p-1.5 text-red-500 hover:text-red-700 bg-white rounded-lg border border-slate-200"
                        title="削除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-1 border-t border-slate-200/60">
                    <button
                      type="button"
                      onClick={() => handleManualAssign('A', m.id)}
                      disabled={isProcessing}
                      className="flex-1 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-[10px] font-black border border-red-200"
                    >
                      Aに配信
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualAssign('B', m.id)}
                      disabled={isProcessing}
                      className="flex-1 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[10px] font-black border border-blue-200"
                    >
                      Bに配信
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* タブ3: 達成承認・手動スコア付与 */}
        {missionTab === 'COMPLETIONS' && (
          <div className="space-y-4">
            {/* 手動達成承認ツール */}
            <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
              <h4 className="text-xs font-black text-indigo-900 mb-2 flex items-center gap-1.5">
                <Award size={14} /> 管理者手動達成承認（ポイント即時加算）
              </h4>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <select
                  value={manualAwardTeam}
                  onChange={e => setManualAwardTeam(e.target.value as 'A' | 'B')}
                  className="p-2 bg-white rounded-xl border border-indigo-200 text-xs font-bold text-slate-800"
                >
                  <option value="A">Team A に加算</option>
                  <option value="B">Team B に加算</option>
                </select>
                <select
                  value={manualAwardMissionId}
                  onChange={e => setManualAwardMissionId(e.target.value)}
                  className="p-2 bg-white rounded-xl border border-indigo-200 text-xs font-bold text-slate-800 truncate"
                >
                  <option value="">ミッションを選択...</option>
                  {allMissionsList.map(m => (
                    <option key={m.id} value={m.id}>[{m.points}pt] {m.title}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleAdminAwardMission}
                disabled={isProcessing || !manualAwardMissionId}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black disabled:opacity-50 transition-all shadow-sm"
              >
                達成を承認してポイントを加算
              </button>
            </div>

            {/* リアルタイム達成フィード */}
            <div>
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">最近の達成履歴</h4>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {liveCompletions.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-4">まだ達成報告はありません</p>
                ) : (
                  liveCompletions.slice(0, 20).map(c => {
                    const mission = allMissionsList.find(m => m.id === c.missionId);
                    return (
                      <div key={c.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs flex justify-between items-center">
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${
                              c.team === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                            }`}>
                              Team {c.team}
                            </span>
                            <span className="font-black text-slate-800">{mission?.title || c.missionId}</span>
                          </div>
                          <span className="text-[10px] text-slate-400">報告者: {c.completedBy}</span>
                        </div>
                        <span className="font-black text-emerald-600 shrink-0">+{c.points}pt</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 6. スナップショット強制位置公開 */}
      <section className="bg-amber-500 p-6 rounded-3xl shadow-xl text-white">
        <h3 className="font-black flex items-center gap-2 mb-3 uppercase tracking-tight text-sm">
          <MapPin size={18} /> 位置強制公開（スナップショット）
        </h3>
        <div className="space-y-3">
          <div className="bg-white/10 p-3 rounded-2xl border border-white/20 flex items-center justify-between">
            <span className="text-xs font-bold">公開時間（分）</span>
            <input
              type="number"
              min={1}
              max={30}
              value={searchDuration}
              onChange={e => setSearchDuration(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              className="w-16 bg-white text-amber-700 font-black p-1.5 rounded-lg text-center text-xs"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleLocationReveal('GLOBAL')}
            disabled={isProcessing}
            className="w-full py-3.5 bg-white text-amber-700 rounded-2xl font-black text-sm shadow-md active:scale-95"
          >
            全員の現在地を公開
          </button>
          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/20">
            <button
              type="button"
              onClick={() => void handleLocationReveal('TEAM_A')}
              disabled={isProcessing}
              className="py-2.5 bg-red-600 text-white rounded-xl font-bold text-xs shadow-md border border-white/10"
            >
              Team A のみ公開
            </button>
            <button
              type="button"
              onClick={() => void handleLocationReveal('TEAM_B')}
              disabled={isProcessing}
              className="py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs shadow-md border border-white/10"
            >
              Team B のみ公開
            </button>
          </div>

          {/* 特定プレイヤーへのミッション違反・ルール違反ペナルティ発動 */}
          <div className="pt-3 border-t border-white/20">
            <h4 className="text-xs font-black flex items-center gap-1.5 mb-1 text-white">
              <AlertTriangle size={14} className="text-yellow-300" />
              ミッション違反・個別ペナルティ発動（位置常時公開）
            </h4>
            <p className="text-[10px] text-amber-100 mb-2 leading-relaxed">
              ミッション不参加や禁止交通機関利用などの違反者に対して、指定時間位置情報を常時開示します。
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={penaltyTargetPlayerId}
                onChange={e => setPenaltyTargetPlayerId(e.target.value)}
                className="flex-1 bg-white text-slate-800 text-xs font-bold p-2.5 rounded-xl border border-amber-300"
              >
                <option value="">対象プレイヤーを選択...</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.name} (Team {u.team} - {u.role})
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 bg-white/10 px-3 py-1.5 rounded-xl border border-white/20">
                <span className="text-[11px] font-bold text-white whitespace-nowrap">時間(分):</span>
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={penaltyDurationMinutes}
                  onChange={e => setPenaltyDurationMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-16 bg-white text-amber-800 text-xs font-black p-1.5 rounded-lg text-center"
                />
              </div>
              <button
                type="button"
                onClick={handleApplyPenalty}
                disabled={isApplyingPenalty || !penaltyTargetPlayerId}
                className="py-2.5 px-4 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-black shadow-md active:scale-95 transition-all disabled:opacity-50 whitespace-nowrap"
              >
                {isApplyingPenalty ? '発動中...' : '🚨 ペナルティ発動'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 7. SOS緊急マップ */}
      {projectionUnavailable && (
        <p role="status" className="rounded-2xl bg-amber-100 p-4 text-sm font-bold text-amber-900">
          Emergency位置を読み込めません。
        </p>
      )}
      <EmergencyProjectionMap projections={emergencyProjections} users={users} />

      {/* 8. プレイヤー一覧 */}
      <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black flex items-center gap-2 mb-3 text-slate-800 uppercase tracking-tight text-sm">
          <Users size={18} className="text-blue-600" />
          参加プレイヤー ({users.length}名)
        </h3>
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {users.map(u => (
            <div key={u.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
              <div>
                <div className="text-xs font-black text-slate-800">{u.name}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className={`text-[9px] font-black px-1.5 py-0.2 rounded-full ${
                    u.team === 'A' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                  }`}>TEAM {u.team}</span>
                  <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600">{u.role}</span>
                  <span className={`text-[9px] font-black px-1.5 py-0.2 rounded-full ${
                    u.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'
                  }`}>{u.status}</span>
                  {Boolean(u.penaltyRevealUntil && u.penaltyRevealUntil > Date.now()) && (
                    <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-rose-500 text-white animate-pulse">
                      🚨 ペナルティ開示中
                    </span>
                  )}
                  {Boolean(u.protectionZone && u.protectionZone !== 'NONE') && (
                    <span className="text-[9px] font-black px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-700">
                      🛡️ {u.protectionZone === 'GREEN_CAR' ? 'グリーン車' : '特例保護'}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleChangePlayerTeam(u)}
                  disabled={modifyingPlayerIds.has(u.id)}
                  title={`TEAM ${u.team === 'A' ? 'B' : 'A'} へ変更`}
                  className="px-2 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-black rounded-lg border border-slate-300 flex items-center gap-1 active:scale-95"
                >
                  <ArrowLeftRight size={12} /> {u.team === 'A' ? '→B' : '→A'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleResumePlayer(u)}
                  disabled={resumingPlayerIds.has(u.id) || modifyingPlayerIds.has(u.id)}
                  title="待機状態から復帰させる"
                  className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg border border-emerald-100 hover:bg-emerald-100 active:scale-95"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeletePlayer(u)}
                  disabled={modifyingPlayerIds.has(u.id)}
                  title="プレイヤーを削除"
                  className="p-1.5 bg-red-50 text-red-600 rounded-lg border border-red-100 hover:bg-red-100 active:scale-95"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 9. スコア補正 */}
      <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
        <h3 className="font-black mb-3 flex items-center gap-2 text-slate-800 text-sm uppercase">
          <Trophy size={18} className="text-amber-500" />
          スコア手動補正
        </h3>
        <div className="grid grid-cols-2 gap-3 mb-3">
          {(['A', 'B'] as const).map(t => (
            <div key={t} className="p-3 bg-slate-50 rounded-2xl border border-slate-100 text-center">
              <div className="text-[10px] font-black text-slate-400 uppercase">Team {t}</div>
              <div className="text-xl font-black text-slate-900">{t === 'A' ? (config.teamAScore ?? 0) : (config.teamBScore ?? 0)} <span className="text-xs">pt</span></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select value={scoreTeam} onChange={e => setScoreTeam(e.target.value as 'A' | 'B')} className="p-2 border rounded-xl text-xs font-bold text-slate-800">
            <option value="A">Team A</option>
            <option value="B">Team B</option>
          </select>
          <input
            type="number"
            value={scoreDeltaInput}
            onChange={e => setScoreDeltaInput(e.target.value)}
            className="p-2 border rounded-xl text-xs font-bold text-slate-800"
            placeholder="増減値 (例: 10 / -5)"
          />
        </div>
        <div className="mt-2">
          <label htmlFor="score-reason-select" className="block text-[10px] font-black text-slate-500 mb-1">補正理由</label>
          <select
            id="score-reason-select"
            value={scoreReasonCode}
            onChange={e => setScoreReasonCode(e.target.value as ScoreAdjustmentReasonCode)}
            className="w-full p-2 border rounded-xl text-xs font-bold text-slate-800"
          >
            <option value="CORRECTION">スコア訂正</option>
            <option value="BONUS">運営ボーナス</option>
            <option value="PENALTY">運営ペナルティ</option>
            <option value="OTHER">その他の運営調整</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => void handleAdjustTeamScore()}
          disabled={isProcessing}
          className="mt-2 w-full py-2.5 bg-indigo-600 text-white rounded-xl font-black text-xs disabled:opacity-50"
        >
          スコアを補正する
        </button>
        {scoreAdjustmentResult && (
          <p role="status" className="mt-2 text-center text-xs font-bold text-emerald-700">
            Team {scoreAdjustmentResult.team}: {scoreAdjustmentResult.previousScore} → {scoreAdjustmentResult.nextScore} pt
          </p>
        )}
      </section>

      {/* 10. マスターリセット */}
      <section className="rounded-2xl border-2 border-red-100 bg-red-50 p-4 text-slate-800">
        <h3 className="flex items-center gap-2 font-black text-red-700 text-xs">
          <AlertTriangle size={16} /> マスターリセット（新セッション開始）
        </h3>
        <p className="mt-1 text-[11px] font-medium text-slate-600">
          現在のセッションを終了し、すべてをリセットして最初から再スタートします。
        </p>
        <button
          type="button"
          onClick={() => void handlePrepareGameReset()}
          disabled={isProcessing}
          className="mt-3 w-full rounded-xl bg-red-600 py-2.5 font-black text-white text-xs disabled:opacity-50"
        >
          {isProcessing ? '取得中...' : 'リセット確認画面を開く'}
        </button>

        {resetPreview && (
          <div className="mt-3 space-y-2 rounded-xl bg-white p-3 text-xs">
            <p>対象Player: <strong>{resetPreview.participantCount}名</strong></p>
            <label className="block pt-1 font-bold">確認のため「RESET」と入力してください:
              <input value={resetConfirmationText} onChange={e => setResetConfirmationText(e.target.value)} className="mt-1 w-full rounded-lg border p-2 text-xs" />
            </label>
            <button
              type="button"
              onClick={() => void handleExecuteGameReset()}
              disabled={resetConfirmationText !== 'RESET'}
              className="mt-2 w-full rounded-xl bg-red-600 py-2.5 font-black text-white disabled:bg-slate-300"
            >
              リセットを実行して新規ゲームを開始
            </button>
          </div>
        )}
        {resetError && <p role="alert" className="mt-2 text-xs font-bold text-red-700">{resetError}</p>}
        {resetSuccess && <p role="status" className="mt-2 text-xs font-bold text-emerald-700">{resetSuccess}</p>}
      </section>

      {/* QRコード拡大モーダル */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-5" role="dialog">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl text-center">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-black text-slate-900">参加用 QRコード</h3>
              <button type="button" onClick={() => setShowQrModal(false)} className="p-1 text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>

            <div className="flex justify-center p-4 bg-white rounded-2xl border border-slate-100 shadow-inner mb-4">
              {qrDataUri && (
                <img src={qrDataUri} alt="参加用QRコード" className="w-44 h-44" />
              )}
            </div>

            <p className="text-xs font-bold text-slate-600 mb-4">
              参加者のスマートフォンでこのQRコードを読み取ってください。<br />
              （アプリインストール・メール登録不要）
            </p>

            <button
              type="button"
              onClick={handleCopyInviteUrl}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-black text-xs shadow-md"
            >
              {copiedLink ? 'URLコピー完了！' : '参加URLをコピー'}
            </button>
          </div>
        </div>
      )}

      {/* ミッション作成・編集モーダル */}
      {isMissionModalOpen && (
        <MissionEditModal
          initialMission={editingMission}
          onSave={handleSaveCustomMission}
          onClose={() => { setIsMissionModalOpen(false); setEditingMission(null); }}
        />
      )}
    </div>
  );
};

// ミッション編集・新規作成モーダル
const MissionEditModal: React.FC<{
  initialMission: Mission | null;
  onSave: (m: Mission) => Promise<void>;
  onClose: () => void;
}> = ({ initialMission, onSave, onClose }) => {
  const [title, setTitle] = useState(initialMission?.title || '');
  const [description, setDescription] = useState(initialMission?.description || '');
  const [points, setPoints] = useState(initialMission?.points || 20);
  const [type, setType] = useState<'PHOTO' | 'CHECKIN'>(initialMission?.type || 'PHOTO');
  const [area, setArea] = useState(initialMission?.area || 'ALL');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const mission: Mission = {
      id: initialMission?.id || `custom_${Date.now()}`,
      title: title.trim(),
      description: description.trim(),
      points: Number(points) || 20,
      type,
      area: area || 'ALL',
      region: 'ALL',
    };
    try {
      await onSave(mission);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-5 font-sans" role="dialog">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl text-slate-800">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-base font-black text-slate-900">
            {initialMission ? 'ミッションを編集' : '新規ミッション作成'}
          </h3>
          <button type="button" onClick={onClose} disabled={busy} className="p-1 text-slate-400">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="mission-modal-title" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              ミッション名（タイトル）
            </label>
            <input
              id="mission-modal-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="例: 新宿駅の東口で写真を撮れ"
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              required
            />
          </div>

          <div>
            <label htmlFor="mission-modal-desc" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              詳細説明
            </label>
            <textarea
              id="mission-modal-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="達成条件や撮影ルールなどを記載"
              rows={3}
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-medium"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mission-modal-points" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                獲得ポイント
              </label>
              <select
                id="mission-modal-points"
                value={points}
                onChange={e => setPoints(Number(e.target.value))}
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              >
                <option value={15}>15 pt（手軽）</option>
                <option value={20}>20 pt（普通）</option>
                <option value={25}>25 pt（中級）</option>
                <option value={30}>30 pt（上級）</option>
                <option value={50}>50 pt（超上級）</option>
                <option value={100}>100 pt（クライマックス）</option>
              </select>
            </div>

            <div>
              <label htmlFor="mission-modal-type" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
                タイプ
              </label>
              <select
                id="mission-modal-type"
                value={type}
                onChange={e => setType(e.target.value as 'PHOTO' | 'CHECKIN')}
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
              >
                <option value="PHOTO">📸 写真撮影</option>
                <option value="CHECKIN">📍 駅チェックイン</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="mission-modal-area" className="block text-[10px] font-black text-slate-400 mb-1 uppercase tracking-wider">
              エリア / 路線（任意）
            </label>
            <input
              id="mission-modal-area"
              type="text"
              value={area}
              onChange={e => setArea(e.target.value)}
              placeholder="ALL / 山手線 など"
              className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-bold"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-xs"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-xs shadow-md"
            >
              {busy ? '保存中...' : '保存する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminView;
