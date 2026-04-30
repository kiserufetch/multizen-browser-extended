import { useState, type JSX } from "react";
import { Modal, ModalFooter } from "./ui/Modal";
import { Input, Label } from "./ui/Input";
import { Button } from "./ui/Button";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: "text" | "password";
  confirmLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

export function PromptModal(props: Props): JSX.Element {
  const [value, setValue] = useState(props.defaultValue ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      await props.onSubmit(value);
    } finally {
      setBusy(false);
      setValue("");
    }
  }

  function close(): void {
    setValue("");
    props.onCancel();
  }

  return (
    <Modal
      open={props.open}
      onClose={close}
      title={props.title}
      description={props.description}
      size="sm"
    >
      <div>
        {props.label && <Label>{props.label}</Label>}
        <Input
          autoFocus
          type={props.inputType ?? "text"}
          placeholder={props.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void submit();
          }}
        />
      </div>
      <ModalFooter>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? "…" : (props.confirmLabel ?? "OK")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
