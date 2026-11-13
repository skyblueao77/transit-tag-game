import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GameConfig, User, Mission, MissionCompletion } from '../types';
import { MISSIONS } from '../constants';
import {
  Users, Shield, Play,
  AlertTriangle, MapPin,
  RefreshCw, QrCode, Copy, Check,
  Sparkles, Send, Megaphone
} from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'qrcode-svg';
import { isAdminBootstrapCompleted, isCurrentAuthUserAdmin } from '../src/infrastructure/firebase/auth';
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
import {
  sendAdminBroadcast,
  applyAdminPenaltyReveal,
} from '../src/infrastructure/firebase/clientFirestoreGateways';
import { adminChangePlayerTeam, adminDeletePlayer } from '../src/infrastructure/firebase/playerStore';

import {
  subscribeEmergencyLocationProjections,
  subscribeMissionCompletions,
} from '../src/infrastructure/firebase/subscriptions';
import type { EmergencyLocationProjection } from '../types';
import EmergencyProjectionMap from './EmergencyProjectionMap';
import useConfirmDialog from '../src/hooks/useConfirmDialog';
import ConfirmDialog from '../src/components/ui/ConfirmDialog';
import AdminAuthGate from './admin/AdminAuthGate';
import AdminRuleSettingsSection from './admin/AdminRuleSettingsSection';
import AdminMissionCenter from './admin/AdminMissionCenter';
import AdminPlayerListSection from './admin/AdminPlayerListSection';
import AdminScoreAdjustmentSection from './admin/AdminScoreAdjustmentSection';
import AdminMasterResetSection from './admin/AdminMasterResetSection';
import InviteQrModal from './admin/InviteQrModal';
import MissionEditModal from './admin/MissionEditModal';

interface Props {
  config: GameConfig;
  users: User[];
  missions: Mission[];
}

const AdminView: React.FC<Props> = ({ config, users = [], missions = [] }) => {
  const { confirm, dialogProps } = useConfirmDialog();
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [isBootstrapCompleted, setIsBootstrapCompleted] = useState<boolean | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);

  // 全体一斉通知
  const [broadcastInput, setBroadcastInput] = useState('');
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);

  // ペナルティ発動関連
  const [penaltyTargetPlayerId, setPenaltyTargetPlayerId] = useState<string>('');
  const [penaltyDurationMinutes, setPenaltyDurationMinutes] = useState<number>(10);
  const [isApplyingPenalty, setIsApplyingPenalty] = useState(false);

  // プレイヤー管理
  const [modifyingPlayerIds, setModifyingPlayerIds] = useState<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

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

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 5000);
    return () => clearInterval(timer);
  }, []);

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

  const emergencyPlayerIdsKey = useMemo(
    () => users.filter(user => user.status === 'EMERGENCY' && (user.team === 'A' || user.team === 'B')).map(user => user.id).sort().join(','),
    [users],
  );
  const emergencyPlayerIds = useMemo(
    () => (emergencyPlayerIdsKey ? emergencyPlayerIdsKey.split(',') : []),
    [emergencyPlayerIdsKey],
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
    let mounted = true;
    (async () => {
      try {
        const isAdminUser = await isCurrentAuthUserAdmin();
        if (mounted && isAdminUser) {
          setIsAuthorized(true);
          return;
        }
        const completed = await isAdminBootstrapCompleted();
        if (mounted) {
          setIsBootstrapCompleted(completed);
          if (!completed) {
            setIsSetupMode(true);
          }
        }
      } catch (err) {
        console.error('Error verifying admin authentication / bootstrap:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

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

    const confirmed = await confirm({
      title: 'フェーズ操作の確認',
      description: `フェーズ操作「${actionLabels[action] || action}」を実行しますか？`,
      confirmLabel: '実行する',
      variant: action === 'END_GAME' ? 'danger' : 'primary',
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: '強制攻守交代の確認',
      description: 'Team A と Team B の役割（鬼・逃走者）を強制的に入れ替えますか？\n※新・鬼側は30分間の待機状態になります。',
      confirmLabel: '入れ替える',
      variant: 'danger',
    });
    if (!confirmed) return;

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
    const confirmed = await confirm({
      title: 'プレイヤー復帰の確認',
      description: `${user.name} をすべての待機状態から復帰させますか？`,
      confirmLabel: '復帰させる',
      variant: 'primary',
    });
    if (!confirmed) return;

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
    const confirmed = await confirm({
      title: '強制位置公開の確認',
      description: `${target}の最新位置を ${searchDuration} 分間、スナップショット公開しますか？`,
      confirmLabel: '公開する',
      variant: 'primary',
    });
    if (!confirmed) return;

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
    const confirmed = await confirm({
      title: 'スコア補正の確認',
      description: `Team ${scoreTeam} を ${delta > 0 ? '+' : ''}${delta}pt 補正しますか？\n理由: ${reasonLabels[scoreReasonCode]}`,
      confirmLabel: '補正する',
      variant: delta < 0 ? 'danger' : 'primary',
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: 'ミッション手動配信',
      description: `Team ${targetTeam} に指定ミッションを配信しますか？`,
      confirmLabel: '配信する',
      variant: 'primary',
    });
    if (!confirmed) return;

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
    const confirmed = await confirm({
      title: 'ミッションランダム配信',
      description: 'ミッションをランダムに選定して両チームへ配信しますか？',
      confirmLabel: '配信する',
      variant: 'primary',
    });
    if (!confirmed) return;
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
    if (!expectedSessionId) return;
    const confirmed = await confirm({
      title: '標準ミッション同期',
      description: '36件の標準ミッションをFirestoreに同期・初期登録しますか？',
      confirmLabel: '同期する',
      variant: 'primary',
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: 'ミッション削除',
      description: `ミッション「${mission.title}」を削除しますか？`,
      confirmLabel: '削除する',
      variant: 'danger',
    });
    if (!confirmed) return;
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

    const confirmed = await confirm({
      title: 'ミッション達成の手動承認',
      description: `Team ${manualAwardTeam} のミッション「${targetMission.title}」達成を承認し、+${targetMission.points}pt 加算しますか？`,
      confirmLabel: '承認する',
      variant: 'primary',
    });
    if (!confirmed) return;

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

  // ミッション違反・ルール違反ペナルティ位置開示の発動
  const handleApplyPenalty = async (): Promise<void> => {
    const expectedSessionId = requireSessionId();
    if (!expectedSessionId || !penaltyTargetPlayerId || isApplyingPenalty) return;

    const targetUser = users.find(u => u.id === penaltyTargetPlayerId);
    if (!targetUser) {
      toast.error('対象プレイヤーが見つかりません');
      return;
    }

    const confirmed = await confirm({
      title: 'ペナルティ位置開示の発動',
      description: `プレイヤー「${targetUser.name}」に${penaltyDurationMinutes}分間のペナルティ（位置常時開示）を発動しますか？`,
      confirmLabel: '発動する',
      variant: 'danger',
    });
    if (!confirmed) return;

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
    const confirmed = await confirm({
      title: 'チーム変更の確認',
      description: `${user.name} のチームを TEAM ${nextTeam} に変更しますか？`,
      confirmLabel: '変更する',
      variant: 'primary',
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: 'プレイヤー削除の確認',
      description: `本当にプレイヤー「${user.name}」を削除しますか？\n（位置情報や参加データも同時に削除されます）`,
      confirmLabel: '削除する',
      variant: 'danger',
    });
    if (!confirmed) return;
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
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (error) {
      console.error('Failed to copy invite URL:', error);
      toast.error('URLのコピーに失敗しました。手動で選択してコピーしてください。');
    }
  };

  // 招待メッセージコピー
  const handleCopyInviteMessage = async () => {
    if (!inviteUrl) return;
    const msg = `🚆【鉄道鬼ごっこ】ゲームに参加しよう！\nインストール不要！以下のURLを開き、お好きなユーザーIDとパスワードで参加してね：\n${inviteUrl}`;
    try {
      await navigator.clipboard.writeText(msg);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2500);
    } catch (error) {
      console.error('Failed to copy invite message:', error);
      toast.error('案内文のコピーに失敗しました。手動でコピーしてください。');
    }
  };

  // ミッション一覧（Firestoreのmissionsを最優先、空ならconstantsのMISSIONS）
  const allMissionsList = useMemo(() => {
    return missions.length > 0 ? missions : MISSIONS;
  }, [missions]);

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
      <AdminAuthGate
        isBootstrapCompleted={isBootstrapCompleted}
        initialSetupMode={isSetupMode}
        onAuthorized={() => setIsAuthorized(true)}
        onBootstrapCompleted={() => setIsBootstrapCompleted(true)}
      />
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
      <AdminRuleSettingsSection config={config} requireSessionId={requireSessionId} />

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
      <AdminMissionCenter
        config={config}
        allMissionsList={allMissionsList}
        filteredMissions={filteredMissions}
        liveCompletions={liveCompletions}
        missionTab={missionTab}
        onChangeTab={setMissionTab}
        missionSearch={missionSearch}
        onChangeSearch={setMissionSearch}
        manualMissionId={manualMissionId}
        onChangeManualMissionId={setManualMissionId}
        manualAwardTeam={manualAwardTeam}
        onChangeManualAwardTeam={setManualAwardTeam}
        manualAwardMissionId={manualAwardMissionId}
        onChangeManualAwardMissionId={setManualAwardMissionId}
        isProcessing={isProcessing}
        onCreateMission={() => { setEditingMission(null); setIsMissionModalOpen(true); }}
        onEditMission={mission => { setEditingMission(mission); setIsMissionModalOpen(true); }}
        onDeleteMission={mission => { void handleDeleteMission(mission); }}
        onToggleMissionMode={() => { void handleToggleMissionMode(); }}
        onManualAssign={(team, id) => { void handleManualAssign(team, id); }}
        onShuffleMissions={() => { void handleShuffleMissions(); }}
        onSyncMissionCatalog={() => { void handleSyncMissionCatalog(); }}
        onAdminAwardMission={() => { void handleAdminAwardMission(); }}
      />

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
      <AdminPlayerListSection
        users={users}
        nowMs={nowMs}
        modifyingPlayerIds={modifyingPlayerIds}
        resumingPlayerIds={resumingPlayerIds}
        onChangePlayerTeam={handleChangePlayerTeam}
        onResumePlayer={handleResumePlayer}
        onDeletePlayer={handleDeletePlayer}
      />

      {/* 9. スコア補正 */}
      <AdminScoreAdjustmentSection
        config={config}
        scoreTeam={scoreTeam}
        onChangeScoreTeam={setScoreTeam}
        scoreDeltaInput={scoreDeltaInput}
        onChangeScoreDeltaInput={setScoreDeltaInput}
        scoreReasonCode={scoreReasonCode}
        onChangeScoreReasonCode={setScoreReasonCode}
        isProcessing={isProcessing}
        onAdjustTeamScore={handleAdjustTeamScore}
        scoreAdjustmentResult={scoreAdjustmentResult}
      />

      {/* 10. マスターリセット */}
      <AdminMasterResetSection
        isProcessing={isProcessing}
        resetPreview={resetPreview}
        resetConfirmationText={resetConfirmationText}
        onChangeResetConfirmationText={setResetConfirmationText}
        resetError={resetError}
        resetSuccess={resetSuccess}
        onPrepareGameReset={handlePrepareGameReset}
        onExecuteGameReset={handleExecuteGameReset}
      />

      {/* QRコード拡大モーダル */}
      {showQrModal && (
        <InviteQrModal
          qrDataUri={qrDataUri}
          copiedLink={copiedLink}
          onCopyInviteUrl={() => { void handleCopyInviteUrl(); }}
          onClose={() => setShowQrModal(false)}
        />
      )}

      {/* ミッション作成・編集モーダル */}
      {isMissionModalOpen && (
        <MissionEditModal
          initialMission={editingMission}
          onSave={handleSaveCustomMission}
          onClose={() => { setIsMissionModalOpen(false); setEditingMission(null); }}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
};

export default AdminView;
