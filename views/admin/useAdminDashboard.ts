import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameConfig, User, Mission, MissionCompletion, EmergencyLocationProjection } from '../../types';
import { MISSIONS } from '../../constants';
import { toast } from 'sonner';
import QRCode from 'qrcode-svg';
import { getRoleForTeam } from '../../src/game';
import { isAdminBootstrapCompleted, isCurrentAuthUserAdmin } from '../../src/infrastructure/firebase/auth';
import { resumePlayer, swapTeamRoles } from '../../src/application/adminGameStateActions';
import { revealPlayerLocations } from '../../src/application/adminReveal';
import type { AdminRevealScope } from '../../src/game/adminReveal';
import { firebaseAdminGameStateGateway } from '../../src/infrastructure/firebase/adminActions';
import { firebaseAdminRevealGateway } from '../../src/infrastructure/firebase/adminRevealActions';
import { transitionGamePhase } from '../../src/application/adminPhaseActions';
import { firebaseAdminPhaseGateway } from '../../src/infrastructure/firebase/adminPhaseActions';
import { setMissionMode, assignMissions, syncMissionCatalog } from '../../src/application/adminMissionActions';
import { firebaseAdminMissionGateway } from '../../src/infrastructure/firebase/adminMissionActions';
import { adjustTeamScore } from '../../src/application/adminScoreAdjustment';
import type { AdjustTeamScoreResult, ScoreAdjustmentReasonCode } from '../../src/application/gameplayPorts';
import { firebaseAdminScoreAdjustmentGateway } from '../../src/infrastructure/firebase/adminScoreAdjustmentActions';
import { prepareGameReset, executeGameReset } from '../../src/application/gameReset';
import type { PrepareGameResetPreview } from '../../src/application/gameplayPorts';
import { firebaseAdminGameResetGateway } from '../../src/infrastructure/firebase/adminGameResetActions';
import { initializeGameSession } from '../../src/application/initializeGameSession';
import { firebaseGameSessionInitializationGateway } from '../../src/infrastructure/firebase/adminSessionActions';
import { createOrUpdateMission, deleteMission, awardMissionCompletionByAdmin } from '../../src/infrastructure/firebase/missionStore';
import {
  sendAdminBroadcast,
  applyAdminPenaltyReveal,
} from '../../src/infrastructure/firebase/clientFirestoreGateways';
import { adminChangePlayerTeam, adminDeletePlayer } from '../../src/infrastructure/firebase/playerStore';
import {
  createEmergencyLocationProjectionsSubscriber,
  type EmergencyLocationProjectionsSubscriber,
  subscribeMissionCompletions,
} from '../../src/infrastructure/firebase/subscriptions';
import type { PhaseControlAction } from './AdminPhaseControlSection';
import type { ConfirmOptions } from '../../src/hooks/useConfirmDialog';

interface UseAdminDashboardParams {
  config: GameConfig;
  users: User[];
  missions: Mission[];
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export function useAdminDashboard({ config, users, missions, confirm }: UseAdminDashboardParams) {
  const [isSetupMode, setIsSetupMode] = useState(false);
  const [isBootstrapCompleted, setIsBootstrapCompleted] = useState<boolean | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);

  const [broadcastInput, setBroadcastInput] = useState('');
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);

  const [penaltyTargetPlayerId, setPenaltyTargetPlayerId] = useState<string>('');
  const [penaltyDurationMinutes, setPenaltyDurationMinutes] = useState<number>(10);
  const [isApplyingPenalty, setIsApplyingPenalty] = useState(false);

  const [modifyingPlayerIds, setModifyingPlayerIds] = useState<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [missionTab, setMissionTab] = useState<'DISPATCH' | 'CATALOG' | 'COMPLETIONS'>('DISPATCH');
  const [missionSearch, setMissionSearch] = useState('');
  const [editingMission, setEditingMission] = useState<Mission | null>(null);
  const [isMissionModalOpen, setIsMissionModalOpen] = useState(false);
  const [manualAwardTeam, setManualAwardTeam] = useState<'A' | 'B'>('A');
  const [manualAwardMissionId, setManualAwardMissionId] = useState('');
  const [liveCompletions, setLiveCompletions] = useState<Array<MissionCompletion & { id: string }>>([]);

  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);

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
  const copiedLinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emergencySubscriberRef = useRef<EmergencyLocationProjectionsSubscriber | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 5000);
    return () => {
      clearInterval(timer);
      if (copiedLinkTimerRef.current) clearTimeout(copiedLinkTimerRef.current);
      if (copiedTextTimerRef.current) clearTimeout(copiedTextTimerRef.current);
    };
  }, []);

  const inviteUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}${window.location.pathname}#/`;
  }, []);

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
    () => users
      .filter(user => user.status === 'EMERGENCY' && (user.team === 'A' || user.team === 'B'))
      .map(user => user.id)
      .sort(),
    [users],
  );
  const emergencyPlayerIdsKey = useMemo(() => emergencyPlayerIds.join(','), [emergencyPlayerIds]);
  const emergencyPlayerIdsRef = useRef<string[]>([]);
  emergencyPlayerIdsRef.current = emergencyPlayerIds;

  useEffect(() => {
    if (!isAuthorized) {
      setEmergencyProjections([]);
      setProjectionUnavailable(false);
      emergencySubscriberRef.current = null;
      return;
    }
    const subscriber = createEmergencyLocationProjectionsSubscriber(
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
    emergencySubscriberRef.current = subscriber;
    subscriber.setPlayerIds(emergencyPlayerIdsRef.current);
    return () => {
      if (emergencySubscriberRef.current === subscriber) {
        emergencySubscriberRef.current = null;
      }
      subscriber.dispose();
    };
  }, [isAuthorized, config.gameSessionId]);

  useEffect(() => {
    if (!isAuthorized) return;
    emergencySubscriberRef.current?.setPlayerIds(
      emergencyPlayerIdsKey === '' ? [] : emergencyPlayerIdsRef.current,
    );
  }, [isAuthorized, emergencyPlayerIdsKey]);

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

  const handleQuickSetupWizard = async (): Promise<void> => {
    if (sessionInitializationBusy || isProcessing) return;
    setIsProcessing(true);
    setSessionInitializationBusy(true);
    try {
      sessionInitializationRequestIdRef.current ??= crypto.randomUUID();
      const initResult = await initializeGameSession(
        { requestId: sessionInitializationRequestIdRef.current },
        firebaseGameSessionInitializationGateway,
      );
      if (!initResult.ok) {
        toast.error(`Session初期化に失敗しました: ${initResult.reason}`);
        return;
      }
      sessionInitializationRequestIdRef.current = null;

      const syncResult = await syncMissionCatalog(
        { requestId: crypto.randomUUID(), expectedSessionId: initResult.gameSessionId },
        firebaseAdminMissionGateway,
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
      const result = await initializeGameSession(
        { requestId: sessionInitializationRequestIdRef.current },
        firebaseGameSessionInitializationGateway,
      );
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

  const handlePhaseAction = async (action: PhaseControlAction): Promise<void> => {
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
      const result = await transitionGamePhase(
        { action, requestId: crypto.randomUUID(), expectedSessionId },
        firebaseAdminPhaseGateway,
      );
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
      const result = await revealPlayerLocations(
        { scope, durationMinutes: searchDuration, requestId, expectedSessionId },
        firebaseAdminRevealGateway,
      );
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
      const result = await adjustTeamScore(
        { team: scoreTeam, delta, reasonCode: scoreReasonCode, requestId, expectedSessionId },
        firebaseAdminScoreAdjustmentGateway,
      );
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
        firebaseAdminMissionGateway,
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
      const result = await assignMissions(
        { strategy: 'RANDOM', target: 'BOTH', requestId: missionRequestId(key), expectedSessionId },
        firebaseAdminMissionGateway,
      );
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
      const result = await syncMissionCatalog(
        { requestId: missionRequestId(key), expectedSessionId },
        firebaseAdminMissionGateway,
      );
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

  const allMissionsList = useMemo(() => {
    return missions.length > 0 ? missions : MISSIONS;
  }, [missions]);

  const filteredMissions = useMemo(() => {
    if (!missionSearch.trim()) return allMissionsList;
    const q = missionSearch.toLowerCase();
    return allMissionsList.filter(m => m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
  }, [allMissionsList, missionSearch]);

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

  const handleChangePlayerTeam = async (user: User): Promise<void> => {
    const nextTeam = user.team === 'A' ? 'B' : 'A';
    const nextRole = getRoleForTeam(nextTeam, config);
    const confirmed = await confirm({
      title: 'チーム変更の確認',
      description: `${user.name} のチームを TEAM ${nextTeam} に変更しますか？`,
      confirmLabel: '変更する',
      variant: 'primary',
    });
    if (!confirmed) return;
    setModifyingPlayerIds(prev => new Set(prev).add(user.id));
    try {
      await adminChangePlayerTeam(user.id, nextTeam, nextRole);
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

  const handleCopyInviteUrl = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedLink(true);
      if (copiedLinkTimerRef.current) clearTimeout(copiedLinkTimerRef.current);
      copiedLinkTimerRef.current = setTimeout(() => setCopiedLink(false), 2500);
    } catch (error) {
      console.error('Failed to copy invite URL:', error);
      toast.error('URLのコピーに失敗しました。手動で選択してコピーしてください。');
    }
  };

  const handleCopyInviteMessage = async () => {
    if (!inviteUrl) return;
    const msg = `🚆【鉄道鬼ごっこ】ゲームに参加しよう！\nインストール不要！以下のURLを開き、お好きなユーザーIDとパスワードで参加してね：\n${inviteUrl}`;
    try {
      await navigator.clipboard.writeText(msg);
      setCopiedText(true);
      if (copiedTextTimerRef.current) clearTimeout(copiedTextTimerRef.current);
      copiedTextTimerRef.current = setTimeout(() => setCopiedText(false), 2500);
    } catch (error) {
      console.error('Failed to copy invite message:', error);
      toast.error('案内文のコピーに失敗しました。手動でコピーしてください。');
    }
  };

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

  return {
    isSetupMode,
    isBootstrapCompleted,
    setIsBootstrapCompleted,
    isAuthorized,
    setIsAuthorized,
    broadcastInput,
    setBroadcastInput,
    isSendingBroadcast,
    penaltyTargetPlayerId,
    setPenaltyTargetPlayerId,
    penaltyDurationMinutes,
    setPenaltyDurationMinutes,
    isApplyingPenalty,
    modifyingPlayerIds,
    nowMs,
    missionTab,
    setMissionTab,
    missionSearch,
    setMissionSearch,
    editingMission,
    setEditingMission,
    isMissionModalOpen,
    setIsMissionModalOpen,
    manualAwardTeam,
    setManualAwardTeam,
    manualAwardMissionId,
    setManualAwardMissionId,
    liveCompletions,
    copiedLink,
    copiedText,
    showQrModal,
    setShowQrModal,
    scoreTeam,
    setScoreTeam,
    scoreDeltaInput,
    setScoreDeltaInput,
    scoreReasonCode,
    setScoreReasonCode,
    scoreAdjustmentResult,
    resetPreview,
    resetConfirmationText,
    setResetConfirmationText,
    resetError,
    resetSuccess,
    isProcessing,
    sessionInitializationBusy,
    searchDuration,
    setSearchDuration,
    manualMissionId,
    setManualMissionId,
    emergencyProjections,
    projectionUnavailable,
    resumingPlayerIds,
    inviteUrl,
    qrDataUri,
    allMissionsList,
    filteredMissions,
    phaseLabel,
    requireSessionId,
    handleQuickSetupWizard,
    handleInitializeGameSession,
    handlePhaseAction,
    handleForceRoleSwap,
    handleResumePlayer,
    handleLocationReveal,
    handleAdjustTeamScore,
    handleToggleMissionMode,
    handleManualAssign,
    handleShuffleMissions,
    handleSyncMissionCatalog,
    handleSaveCustomMission,
    handleDeleteMission,
    handleAdminAwardMission,
    handleSendBroadcast,
    handleApplyPenalty,
    handleChangePlayerTeam,
    handleDeletePlayer,
    handlePrepareGameReset,
    handleExecuteGameReset,
    handleCopyInviteUrl,
    handleCopyInviteMessage,
  };
}
