import { useCallback, useRef, useState } from "react";

const PAYLOAD_INLINE_LIMIT = 128 * 1024; // 128KB
const PAYLOAD_MAX_SIZE = 1024 * 1024 * 1024; // 1GB

export type UploadState =
  | { status: "idle" }
  | { status: "presigning" }
  | { status: "uploading"; progress: number }
  | { status: "error"; message: string };

export type PresignedUploadResult =
  | { outcome: "inline" }
  | { outcome: "uploaded"; storagePath: string }
  | { outcome: "failed" };

/**
 * Uses XMLHttpRequest instead of fetch() for the S3 PUT so we can track
 * upload progress via `xhr.upload.onprogress`. The Fetch API does not
 * expose upload progress events.
 */
function uploadWithProgress(
  url: string,
  body: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/json");

    if (signal) {
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new DOMException("Upload aborted", "AbortError"));
      });
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`S3 upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("S3 upload failed")));
    xhr.addEventListener("abort", () =>
      reject(new DOMException("Upload aborted", "AbortError"))
    );

    xhr.send(body);
  });
}

function getByteLength(str: string): number {
  return new Blob([str]).size;
}

/**
 * Hook that handles presigned S3 uploads for large payloads.
 *
 * Payloads <= 128KB are left for inline storage in Postgres.
 * Payloads > 128KB (up to 1GB) are uploaded directly to S3 via a
 * presigned PUT URL, bypassing the webapp server entirely.
 *
 * Returns the current upload state (idle / presigning / uploading / error),
 * an `upload` function to call with the payload and presign endpoint URL,
 * and helpers to dismiss errors and cancel in-flight uploads.
 */
export function usePresignedUpload() {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const dismissError = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  const upload = useCallback(
    async (payload: string, presignUrl: string): Promise<PresignedUploadResult> => {
      const byteLength = getByteLength(payload);

      if (byteLength > PAYLOAD_MAX_SIZE) {
        setState({ status: "error", message: "Payload exceeds the 1GB limit" });
        return { outcome: "failed" };
      }

      if (byteLength <= PAYLOAD_INLINE_LIMIT) {
        return { outcome: "inline" };
      }

      try {
        setState({ status: "presigning" });

        const presignResponse = await fetch(presignUrl, { method: "POST" });
        if (!presignResponse.ok) {
          const body = await presignResponse.json().catch(() => null);
          throw new Error(body?.error ?? "Failed to get upload URL");
        }

        const { presignedUrl, storagePath } = (await presignResponse.json()) as {
          presignedUrl: string;
          storagePath: string;
        };

        abortRef.current = new AbortController();
        setState({ status: "uploading", progress: 0 });

        await uploadWithProgress(
          presignedUrl,
          payload,
          (progress) => setState({ status: "uploading", progress }),
          abortRef.current.signal
        );

        setState({ status: "idle" });
        return { outcome: "uploaded", storagePath };
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setState({ status: "idle" });
          return { outcome: "failed" };
        }
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "Upload failed",
        });
        return { outcome: "failed" };
      } finally {
        abortRef.current = null;
      }
    },
    []
  );

  return { state, upload, abort, dismissError } as const;
}
