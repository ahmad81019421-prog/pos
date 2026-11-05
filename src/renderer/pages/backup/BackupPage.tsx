import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap } from '../../hooks/useApi';
import type { BackupInfo, BackupStatus } from '@shared/types/index';

export default function BackupPage() {
  const { t } = useI18n();
  const { data, reload } = useApi<BackupInfo[]>(() => window.posApi.listBackups());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: statusData, reload: reloadStatus } = useApi<BackupStatus>(() =>
    window.posApi.getBackupStatus(),
  );
  const status = unwrap(statusData);
  const backups = unwrap(data) || [];
  const kindLabel = (k: BackupInfo['kind']) =>
    k === 'pre-restore'
      ? t('backup.kindPreRestore')
      : k === 'pre-upgrade'
        ? t('backup.kindPreUpgrade')
        : '';

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const handleCreate = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    const result = await window.posApi.createBackup();
    setBusy(false);
    if (result && typeof result === 'object' && 'error' in result) {
      setError((result as { error: { userMessage: string } }).error.userMessage);
    } else {
      setSuccess(t('backup.success'));
      reload();
      reloadStatus();
    }
  };

  const handleBackupTo = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    const result = await window.posApi.backupToPath();
    setBusy(false);
    if (result && typeof result === 'object') {
      if ('error' in result) {
        setError(result.error.userMessage);
      } else if ('canceled' in result) {
        // user canceled, no error
      } else {
        setSuccess(t('backup.success'));
        reload();
      }
    }
  };

  const finishRestore = (
    result: { safetyBackupPath: string } | { canceled: true } | { error: { userMessage: string } },
  ) => {
    if ('error' in result) {
      setError(result.error.userMessage);
    } else if ('safetyBackupPath' in result) {
      setSuccess(t('backup.restoreDone'));
      setTimeout(() => window.location.reload(), 1500);
    }
  };

  const handleRestore = async (fileName: string) => {
    setError(null);
    setSuccess(null);
    if (!confirm(`${t('backup.confirmRestore')}\n\n${t('backup.confirmRestoreText')}`)) return;
    setBusy(true);
    try {
      finishRestore(await window.posApi.restoreBackup(fileName));
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreFromFile = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      finishRestore(await window.posApi.restoreFromFile());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('backup.title')}</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="flex gap-8 mb-16">
        <button
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : `💾 ${t('backup.create')}`}
        </button>
        <button
          className="btn"
          onClick={handleBackupTo}
          disabled={busy}
        >
          📁 {t('backup.toUsb')}
        </button>
        <button className="btn btn-danger" onClick={handleRestoreFromFile} disabled={busy}>
          {t('backup.restoreFromFile')}
        </button>
      </div>

      {status?.lastError && (
        <div className="alert alert-error">
          {t('backup.lastError')}: {status.lastError}
        </div>
      )}
      {status?.latestBackupAt && (
        <div className="text-muted mb-16">
          {t('backup.lastSuccess')}: {new Date(status.latestBackupAt * 1000).toLocaleString()}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>{t('backup.list')}</h2>
      {backups.length === 0 ? (
        <div className="empty-state">
          <div className="icon">💾</div>
          <div>{t('backup.noBackups')}</div>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('backup.date')}</th>
              <th>{t('backup.size')}</th>
              <th>{t('invoices.number')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.fileName}>
                <td>{new Date(b.createdAt * 1000).toLocaleString()}</td>
                <td>{formatBytes(b.sizeBytes)}</td>
                <td>{b.fileName} {kindLabel(b.kind) && <em>({kindLabel(b.kind)})</em>}</td>
                <td>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => handleRestore(b.fileName)}
                    disabled={busy}
                  >
                    {t('backup.restore')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
