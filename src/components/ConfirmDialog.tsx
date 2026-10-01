import type { ReactNode } from "react";

interface Props {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Bestätigungsdialog im App-Stil (statt window.confirm). */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: Props) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <div className="card stack" style={{ textAlign: "left" }} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={onCancel}>Abbrechen</button>
          <button className={danger ? "danger-solid" : "primary"} onClick={onConfirm} data-testid="confirm">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
