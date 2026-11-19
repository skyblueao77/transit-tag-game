import React from 'react';
import { AlertTriangle, Check, Copy, Home, Phone, RefreshCw } from 'lucide-react';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  scope?: 'app' | 'route';
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
  showDetails: boolean;
  copied: boolean;
}

export function formatErrorReport(error: Error | null, componentStack: string, url?: string): string {
  const lines = [
    `[Transit Tag Error Report]`,
    `Time: ${new Date().toISOString()}`,
    ...(url ? [`URL: ${url}`] : []),
    `Error: ${error?.name || 'Error'}: ${error?.message || 'Unknown error'}`,
  ];
  if (error?.stack) {
    lines.push('', 'Stack:', error.stack.split('\n').slice(0, 10).join('\n'));
  }
  if (componentStack.trim()) {
    lines.push('', 'Component Stack:', componentStack.trim().split('\n').slice(0, 10).join('\n'));
  }
  return lines.join('\n');
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      componentStack: '',
      showDetails: false,
      copied: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.scope ?? 'app'}] Caught render error:`, error, errorInfo);
    this.setState({
      componentStack: errorInfo.componentStack ?? '',
    });
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && this.props.resetKey !== undefined && prevProps.resetKey !== this.props.resetKey) {
      this.setState({
        hasError: false,
        error: null,
        componentStack: '',
        showDetails: false,
        copied: false,
      });
    }
  }

  override componentWillUnmount(): void {
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
  }

  private handleReload = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  private handleResetBoundary = (): void => {
    this.setState({
      hasError: false,
      error: null,
      componentStack: '',
      showDetails: false,
      copied: false,
    });
  };

  private handleGoToMap = (): void => {
    this.handleResetBoundary();
    if (typeof window !== 'undefined') {
      window.location.hash = '#/map';
    }
  };

  private handleCopyDetails = async (): Promise<void> => {
    const safeUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}${window.location.hash.split('?')[0]}`
      : undefined;
    const report = formatErrorReport(this.state.error, this.state.componentStack, safeUrl);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        this.setState({ copied: true });
        if (this.copiedTimer) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => {
          this.setState({ copied: false });
        }, 2500);
      }
    } catch (copyError) {
      console.error('Failed to copy error details:', copyError);
    }
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const isAppScope = (this.props.scope ?? 'app') === 'app';
    const safeUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}${window.location.hash.split('?')[0]}`
      : undefined;
    const reportText = formatErrorReport(this.state.error, this.state.componentStack, safeUrl);

    return (
      <div
        role="alert"
        className={`${
          isAppScope ? 'min-h-[100dvh] bg-slate-950 text-white' : 'min-h-full bg-slate-900 text-white'
        } flex flex-col items-center justify-center p-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] font-sans`}
      >
        <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-slate-700/80 shadow-2xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-2xl bg-red-500/20 border border-red-500/40 flex items-center justify-center shrink-0 text-red-400">
              <AlertTriangle size={26} />
            </div>
            <div>
              <h1 className="text-lg font-black text-white">
                {isAppScope ? 'アプリで予期しないエラーが発生しました' : 'この画面の表示中にエラーが発生しました'}
              </h1>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                再読み込みすると復旧する場合があります。通信が安定している場所で再度お試しください。
              </p>
            </div>
          </div>

          <div className="rounded-2xl bg-red-950/60 border border-red-500/40 p-4 space-y-1.5 text-xs">
            <div className="font-black text-red-300 flex items-center gap-1.5">
              <Phone size={14} /> 緊急時の連絡案内（SOS）
            </div>
            <p className="text-red-100 leading-relaxed">
              怪我・体調不良・危険を感じた場合は、アプリ復旧を待たずに直ちに
              <strong className="text-white"> 119番（救急）・110番（警察）・最寄りの駅係員 </strong>
              へ連絡し、安全確保後に運営（LINEグループ等）へ直接ご連絡ください。
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full py-3.5 px-4 bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white rounded-2xl font-black text-sm flex items-center justify-center gap-2 shadow-lg transition-all"
            >
              <RefreshCw size={16} /> ページを再読み込み
            </button>
            {!isAppScope && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={this.handleResetBoundary}
                  className="py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-bold text-xs transition-all"
                >
                  画面を再描画
                </button>
                <button
                  type="button"
                  onClick={this.handleGoToMap}
                  className="py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-bold text-xs flex items-center justify-center gap-1 transition-all"
                >
                  <Home size={14} /> マップへ戻る
                </button>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-800 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => this.setState(prev => ({ showDetails: !prev.showDetails }))}
                className="text-[11px] font-bold text-slate-400 hover:text-slate-200 underline underline-offset-2"
              >
                {this.state.showDetails ? 'エラー詳細を隠す' : 'エラー詳細を表示（運営報告用）'}
              </button>
              <button
                type="button"
                onClick={() => { void this.handleCopyDetails(); }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold transition-colors"
              >
                {this.state.copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                <span>{this.state.copied ? 'コピーしました' : 'エラー詳細をコピー'}</span>
              </button>
            </div>
            {this.state.showDetails && (
              <pre className="max-h-40 overflow-auto rounded-xl bg-slate-950 p-3 text-[10px] text-slate-300 font-mono whitespace-pre-wrap break-all border border-slate-800">
                {reportText}
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
