import {
  captureCountersignatureTypes,
  type DerivativeAttachment,
  derivativeAttachmentTypes,
  type KeyEnrolment,
  keyEnrolmentTypes,
} from "@stamper/core";
import { type Address, concat, type Hex, type TypedDataDomain, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Registrar = {
  readonly address: Address;
  /** uint8 level ‖ 65-byte ECDSA over CaptureCountersignature(stampId, level) = 66 bytes. */
  countersign(stampId: Hex, level: number): Promise<Hex>;
  /** 65-byte ECDSA over the whole KeyEnrolment. */
  endorse(e: KeyEnrolment): Promise<Hex>;
  /** 65-byte ECDSA over DerivativeAttachment. */
  attachSig(d: DerivativeAttachment): Promise<Hex>;
};

export function createRegistrar(pk: Hex, domain: TypedDataDomain): Registrar {
  const account = privateKeyToAccount(pk);
  return {
    address: account.address,
    async countersign(stampId, level) {
      if (!Number.isInteger(level) || level < 0 || level > 255) throw new RangeError("level");
      const sig = await account.signTypedData({
        domain,
        types: captureCountersignatureTypes,
        primaryType: "CaptureCountersignature",
        message: { stampId, level },
      });
      return concat([toHex(level, { size: 1 }), sig]);
    },
    endorse(e) {
      return account.signTypedData({
        domain,
        types: keyEnrolmentTypes,
        primaryType: "KeyEnrolment",
        message: e,
      });
    },
    attachSig(d) {
      return account.signTypedData({
        domain,
        types: derivativeAttachmentTypes,
        primaryType: "DerivativeAttachment",
        message: d,
      });
    },
  };
}
