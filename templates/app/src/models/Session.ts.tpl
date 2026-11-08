import { EntitySchema, ReferenceKind } from "@mikro-orm/core";
import { User } from "./User.ts";

export class Session { id!: number; tokenHash!: string; user!: User; expiresAt!: Date; }
export default new EntitySchema<Session>({ class: Session, tableName: "sessions", properties: {
  id: { type: "number", primary: true },
  tokenHash: { type: "string", length: 64, unique: true, hidden: true },
  user: { kind: ReferenceKind.MANY_TO_ONE, entity: () => User, deleteRule: "cascade" },
  expiresAt: { type: Date, index: true },
} });
