export type ToastItem = {
  id: number;
  msg: string;
  action?: { label: string; onClick: () => void };
};

export type ConfirmDialogState = {
  show: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
};
