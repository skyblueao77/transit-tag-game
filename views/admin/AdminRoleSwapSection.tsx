import type React from 'react';
import { RefreshCw } from 'lucide-react';
import type { Role } from '../../types';

interface AdminRoleSwapSectionProps {
  teamARole: Role;
  teamBRole: Role;
  isProcessing: boolean;
  onForceRoleSwap: () => void;
}

const AdminRoleSwapSection: React.FC<AdminRoleSwapSectionProps> = ({
  teamARole,
  teamBRole,
  isProcessing,
  onForceRoleSwap,
}) => (
  <section className="bg-white p-5 rounded-3xl shadow-sm border border-slate-200">
    <h3 className="font-black flex items-center gap-2 mb-3 text-slate-700 text-sm uppercase">
      <RefreshCw size={18} className="text-slate-700" />
      攻守管理（鬼・逃走者）
    </h3>
    <div className="flex justify-between items-center px-4 py-2.5 bg-slate-50 rounded-2xl border border-slate-100 mb-3">
      <div className="text-[10px] font-black text-slate-500 uppercase">現在ステータス</div>
      <div className="flex gap-2 font-black text-xs">
        <span className={teamARole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>
          Team A: {teamARole === 'ONI' ? '👹 鬼' : '🏃 逃走者'}
        </span>
        <span className="text-slate-300">/</span>
        <span className={teamBRole === 'ONI' ? 'text-red-600' : 'text-blue-600'}>
          Team B: {teamBRole === 'ONI' ? '👹 鬼' : '🏃 逃走者'}
        </span>
      </div>
    </div>
    <button
      type="button"
      onClick={onForceRoleSwap}
      disabled={isProcessing}
      className="w-full py-3 bg-slate-900 text-white rounded-xl font-black text-xs shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all"
    >
      <RefreshCw size={16} /> 攻守を強制交代する（30分待機付与）
    </button>
  </section>
);

export default AdminRoleSwapSection;
