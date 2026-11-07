import type React from 'react';

export const LoadingSpinner: React.FC<{ message?: string }> = ({ message = 'Loading...' }) => (
  <div className="flex flex-col items-center justify-center p-8 gap-3 min-h-[200px]">
    <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">{message}</span>
  </div>
);

export default LoadingSpinner;
