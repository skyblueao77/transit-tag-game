import type React from 'react';
import type { GameConfig, User, Mission } from '../types';
import { Shield, QrCode } from 'lucide-react';
import EmergencyProjectionMap from './EmergencyProjectionMap';
import useConfirmDialog from '../src/hooks/useConfirmDialog';
import ConfirmDialog from '../src/components/ui/ConfirmDialog';
import AdminAuthGate from './admin/AdminAuthGate';
import AdminBroadcastSection from './admin/AdminBroadcastSection';
import AdminInviteSection from './admin/AdminInviteSection';
import AdminLocationRevealSection from './admin/AdminLocationRevealSection';
import AdminRuleSettingsSection from './admin/AdminRuleSettingsSection';
import AdminMissionCenter from './admin/AdminMissionCenter';
import AdminPhaseControlSection from './admin/AdminPhaseControlSection';
import AdminPlayerListSection from './admin/AdminPlayerListSection';
import AdminRoleSwapSection from './admin/AdminRoleSwapSection';
import AdminScoreAdjustmentSection from './admin/AdminScoreAdjustmentSection';
import AdminSessionSetupSection from './admin/AdminSessionSetupSection';
import AdminMasterResetSection from './admin/AdminMasterResetSection';
import InviteQrModal from './admin/InviteQrModal';
import MissionEditModal from './admin/MissionEditModal';
import { useAdminDashboard } from './admin/useAdminDashboard';

interface Props {
  config: GameConfig;
  users: User[];
  missions: Mission[];
}

const AdminView: React.FC<Props> = ({ config, users = [], missions = [] }) => {
  const { confirm, dialogProps } = useConfirmDialog();
  const dashboard = useAdminDashboard({ config, users, missions, confirm });

  if (!dashboard.isAuthorized) {
    return (
      <AdminAuthGate
        isBootstrapCompleted={dashboard.isBootstrapCompleted}
        initialSetupMode={dashboard.isSetupMode}
        onAuthorized={() => dashboard.setIsAuthorized(true)}
        onBootstrapCompleted={() => dashboard.setIsBootstrapCompleted(true)}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] bg-slate-100 text-slate-800 font-sans">
      <div className="max-w-6xl mx-auto p-4 sm:p-6 lg:p-8 pb-24 space-y-6">
        <header className="flex justify-between items-center bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-200">
          <div>
            <h1 className="text-lg sm:text-xl font-black text-slate-900 flex items-center gap-2">
              <Shield size={20} className="text-blue-600" />
              運営管理ダッシュボード
            </h1>
            <p className="text-xs text-slate-500 font-medium">
              セッション: {config.gameSessionId ? `${config.gameSessionId.slice(0, 12)}...` : '未初期化'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dashboard.setShowQrModal(true)}
            className="px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 flex items-center gap-1.5 shadow-sm transition-all"
          >
            <QrCode size={14} /> 招待QR
          </button>
        </header>

        <AdminSessionSetupSection
          gameSessionId={config.gameSessionId}
          sessionInitializationBusy={dashboard.sessionInitializationBusy}
          isProcessing={dashboard.isProcessing}
          onQuickSetupWizard={() => { void dashboard.handleQuickSetupWizard(); }}
          onInitializeGameSession={() => { void dashboard.handleInitializeGameSession(); }}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <AdminPhaseControlSection
            gameStatus={config.gameStatus}
            phaseLabel={dashboard.phaseLabel}
            isProcessing={dashboard.isProcessing}
            onPhaseAction={action => { void dashboard.handlePhaseAction(action); }}
          />

          <AdminInviteSection
            users={users}
            inviteUrl={dashboard.inviteUrl}
            copiedLink={dashboard.copiedLink}
            copiedText={dashboard.copiedText}
            onCopyInviteUrl={() => { void dashboard.handleCopyInviteUrl(); }}
            onCopyInviteMessage={() => { void dashboard.handleCopyInviteMessage(); }}
            onOpenQrModal={() => dashboard.setShowQrModal(true)}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-6 min-w-0">
            <AdminMissionCenter
              config={config}
              allMissionsList={dashboard.allMissionsList}
              filteredMissions={dashboard.filteredMissions}
              liveCompletions={dashboard.liveCompletions}
              missionTab={dashboard.missionTab}
              onChangeTab={dashboard.setMissionTab}
              missionSearch={dashboard.missionSearch}
              onChangeSearch={dashboard.setMissionSearch}
              manualMissionId={dashboard.manualMissionId}
              onChangeManualMissionId={dashboard.setManualMissionId}
              manualAwardTeam={dashboard.manualAwardTeam}
              onChangeManualAwardTeam={dashboard.setManualAwardTeam}
              manualAwardMissionId={dashboard.manualAwardMissionId}
              onChangeManualAwardMissionId={dashboard.setManualAwardMissionId}
              isProcessing={dashboard.isProcessing}
              onCreateMission={() => {
                dashboard.setEditingMission(null);
                dashboard.setIsMissionModalOpen(true);
              }}
              onEditMission={mission => {
                dashboard.setEditingMission(mission);
                dashboard.setIsMissionModalOpen(true);
              }}
              onDeleteMission={mission => { void dashboard.handleDeleteMission(mission); }}
              onToggleMissionMode={() => { void dashboard.handleToggleMissionMode(); }}
              onManualAssign={(team, id) => { void dashboard.handleManualAssign(team, id); }}
              onShuffleMissions={() => { void dashboard.handleShuffleMissions(); }}
              onSyncMissionCatalog={() => { void dashboard.handleSyncMissionCatalog(); }}
              onAdminAwardMission={() => { void dashboard.handleAdminAwardMission(); }}
            />

            <AdminRuleSettingsSection config={config} requireSessionId={dashboard.requireSessionId} />

            {dashboard.projectionUnavailable && (
              <p role="status" className="rounded-2xl bg-amber-100 p-4 text-sm font-bold text-amber-900">
                Emergency位置を読み込めません。
              </p>
            )}
            <EmergencyProjectionMap projections={dashboard.emergencyProjections} users={users} />
          </div>

          <div className="lg:col-span-5 space-y-6 min-w-0">
            <AdminLocationRevealSection
              config={config}
              users={users}
              searchDuration={dashboard.searchDuration}
              penaltyTargetPlayerId={dashboard.penaltyTargetPlayerId}
              penaltyDurationMinutes={dashboard.penaltyDurationMinutes}
              isProcessing={dashboard.isProcessing}
              isApplyingPenalty={dashboard.isApplyingPenalty}
              onChangeSearchDuration={dashboard.setSearchDuration}
              onLocationReveal={scope => { void dashboard.handleLocationReveal(scope); }}
              onChangePenaltyTargetPlayerId={dashboard.setPenaltyTargetPlayerId}
              onChangePenaltyDurationMinutes={dashboard.setPenaltyDurationMinutes}
              onApplyPenalty={() => { void dashboard.handleApplyPenalty(); }}
            />

            <AdminBroadcastSection
              broadcastInput={dashboard.broadcastInput}
              isSendingBroadcast={dashboard.isSendingBroadcast}
              onChangeBroadcastInput={dashboard.setBroadcastInput}
              onSubmitBroadcast={dashboard.handleSendBroadcast}
            />

            <AdminRoleSwapSection
              teamARole={config.teamARole}
              teamBRole={config.teamBRole}
              isProcessing={dashboard.isProcessing}
              onForceRoleSwap={() => { void dashboard.handleForceRoleSwap(); }}
            />

            <AdminPlayerListSection
              config={config}
              users={users}
              nowMs={dashboard.nowMs}
              modifyingPlayerIds={dashboard.modifyingPlayerIds}
              resumingPlayerIds={dashboard.resumingPlayerIds}
              onChangePlayerTeam={dashboard.handleChangePlayerTeam}
              onResumePlayer={dashboard.handleResumePlayer}
              onDeletePlayer={dashboard.handleDeletePlayer}
            />

            <AdminScoreAdjustmentSection
              config={config}
              scoreTeam={dashboard.scoreTeam}
              onChangeScoreTeam={dashboard.setScoreTeam}
              scoreDeltaInput={dashboard.scoreDeltaInput}
              onChangeScoreDeltaInput={dashboard.setScoreDeltaInput}
              scoreReasonCode={dashboard.scoreReasonCode}
              onChangeScoreReasonCode={dashboard.setScoreReasonCode}
              isProcessing={dashboard.isProcessing}
              onAdjustTeamScore={dashboard.handleAdjustTeamScore}
              scoreAdjustmentResult={dashboard.scoreAdjustmentResult}
            />

            <AdminMasterResetSection
              isProcessing={dashboard.isProcessing}
              resetPreview={dashboard.resetPreview}
              resetConfirmationText={dashboard.resetConfirmationText}
              onChangeResetConfirmationText={dashboard.setResetConfirmationText}
              resetError={dashboard.resetError}
              resetSuccess={dashboard.resetSuccess}
              onPrepareGameReset={dashboard.handlePrepareGameReset}
              onExecuteGameReset={dashboard.handleExecuteGameReset}
            />
          </div>
        </div>
      </div>

      {dashboard.showQrModal && (
        <InviteQrModal
          qrDataUri={dashboard.qrDataUri}
          copiedLink={dashboard.copiedLink}
          onCopyInviteUrl={() => { void dashboard.handleCopyInviteUrl(); }}
          onClose={() => dashboard.setShowQrModal(false)}
        />
      )}

      {dashboard.isMissionModalOpen && (
        <MissionEditModal
          initialMission={dashboard.editingMission}
          onSave={dashboard.handleSaveCustomMission}
          onClose={() => {
            dashboard.setIsMissionModalOpen(false);
            dashboard.setEditingMission(null);
          }}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
};

export default AdminView;
