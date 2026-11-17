import { BehaviorSubject } from "rxjs";

export type SignatureVerificationMode = "full" | "optimistic" | "none";
const KEY = "accordion:signatureVerification";

function loadMode(): SignatureVerificationMode {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "optimistic" || value === "none") return value;
  } catch { /* Storage may be unavailable. */ }
  return "full";
}

export const signatureVerificationMode$ = new BehaviorSubject<SignatureVerificationMode>(loadMode());

export function setSignatureVerificationMode(mode: SignatureVerificationMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch { /* Keep the in-memory preference when storage is unavailable. */ }
  signatureVerificationMode$.next(mode);
}
