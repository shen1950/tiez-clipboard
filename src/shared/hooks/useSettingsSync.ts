import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DuplicateMode } from "../../features/app/types";

interface UseSettingsSyncOptions {
  settingsLoaded: boolean;
  duplicateMode: DuplicateMode;
  saveAppSetting: (type: string, value: string) => void;
  captureFiles: boolean;
  captureRichText: boolean;
  fileTransferAutoCopy: boolean;
  fileServerAutoClose: boolean;
  fileServerAutoCloseSeconds: string;
  fileTransferAutoOpen: boolean;
  persistent: boolean;
  soundVolume: number;
  arrowKeySelection: boolean;
  setIsKeyboardMode: (val: boolean) => void;
  setSelectedIndex: (val: number) => void;
}

export const useSettingsSync = ({
  settingsLoaded,
  duplicateMode,
  saveAppSetting,
  captureFiles,
  captureRichText,
  fileTransferAutoCopy,
  fileServerAutoClose,
  fileServerAutoCloseSeconds,
  fileTransferAutoOpen,
  persistent,
  soundVolume,
  arrowKeySelection,
  setIsKeyboardMode,
  setSelectedIndex
}: UseSettingsSyncOptions) => {
  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_duplicate_mode", { mode: duplicateMode }).catch(console.error);
      saveAppSetting("duplicate_mode", duplicateMode);
    }
  }, [duplicateMode, saveAppSetting, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_capture_files", { enabled: captureFiles });
    }
  }, [captureFiles, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_capture_rich_text", { enabled: captureRichText });
    }
  }, [captureRichText, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_auto_copy_file", { enabled: fileTransferAutoCopy });
    }
  }, [fileTransferAutoCopy, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_file_server_auto_close", { enabled: fileServerAutoClose }).catch(console.error);
    }
  }, [fileServerAutoClose, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      const seconds = Math.max(0, parseInt(fileServerAutoCloseSeconds, 10) || 0);
      invoke("set_file_transfer_auto_close_seconds", { seconds }).catch(console.error);
    }
  }, [fileServerAutoCloseSeconds, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_file_transfer_auto_open", { enabled: fileTransferAutoOpen }).catch(console.error);
    }
  }, [fileTransferAutoOpen, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      invoke("set_persistence", { enabled: persistent });
    }
  }, [persistent, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      saveAppSetting("sound_volume", String(soundVolume));
    }
  }, [saveAppSetting, settingsLoaded, soundVolume]);

  useEffect(() => {
    invoke("set_arrow_key_selection", { enabled: arrowKeySelection }).catch(console.error);
    if (!arrowKeySelection) {
      setIsKeyboardMode(false);
      setSelectedIndex(0);
    }
  }, [arrowKeySelection, setIsKeyboardMode, setSelectedIndex]);
};
