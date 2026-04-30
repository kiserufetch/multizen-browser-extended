import { type JSX } from "react";
import { Modal, ModalFooter } from "./ui/Modal";
import { Button } from "./ui/Button";

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal(props: Props): JSX.Element {
  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      size="sm"
    >
      <p className="text-sm text-[--color-fg-muted] leading-relaxed">{props.description}</p>
      <ModalFooter>
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          variant={props.destructive ? "danger" : "primary"}
          onClick={props.onConfirm}
        >
          {props.confirmLabel ?? "Confirm"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
