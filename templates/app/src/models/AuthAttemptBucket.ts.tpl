import { EntitySchema } from "@mikro-orm/core";

// One singleton, exactly 20 ordered epoch-millisecond slots. Zero means unused.
// Portable bounds/order checks keep app migrations usable on every Bundle driver.
// The SQLite-only limiter also validates safe integer state before admission.
export class AuthAttemptBucket { id!: number;
  slot0!: number;
  slot1!: number;
  slot2!: number;
  slot3!: number;
  slot4!: number;
  slot5!: number;
  slot6!: number;
  slot7!: number;
  slot8!: number;
  slot9!: number;
  slot10!: number;
  slot11!: number;
  slot12!: number;
  slot13!: number;
  slot14!: number;
  slot15!: number;
  slot16!: number;
  slot17!: number;
  slot18!: number;
  slot19!: number;
}
export default new EntitySchema<AuthAttemptBucket>({
  class: AuthAttemptBucket, tableName: "auth_attempt_bucket",
  properties: {
    id: { type: "integer", primary: true, autoincrement: false },
    slot0: { type: "integer", fieldName: "slot_0" },
    slot1: { type: "integer", fieldName: "slot_1" },
    slot2: { type: "integer", fieldName: "slot_2" },
    slot3: { type: "integer", fieldName: "slot_3" },
    slot4: { type: "integer", fieldName: "slot_4" },
    slot5: { type: "integer", fieldName: "slot_5" },
    slot6: { type: "integer", fieldName: "slot_6" },
    slot7: { type: "integer", fieldName: "slot_7" },
    slot8: { type: "integer", fieldName: "slot_8" },
    slot9: { type: "integer", fieldName: "slot_9" },
    slot10: { type: "integer", fieldName: "slot_10" },
    slot11: { type: "integer", fieldName: "slot_11" },
    slot12: { type: "integer", fieldName: "slot_12" },
    slot13: { type: "integer", fieldName: "slot_13" },
    slot14: { type: "integer", fieldName: "slot_14" },
    slot15: { type: "integer", fieldName: "slot_15" },
    slot16: { type: "integer", fieldName: "slot_16" },
    slot17: { type: "integer", fieldName: "slot_17" },
    slot18: { type: "integer", fieldName: "slot_18" },
    slot19: { type: "integer", fieldName: "slot_19" },
  },
  checks: [
    { name: "auth_bucket_singleton", expression: "id = 1" },
    { name: "auth_bucket_slot_0", expression: "slot_0 >= 0 and slot_0 <= 9007199254740991" },
    { name: "auth_bucket_slot_1", expression: "slot_1 >= 0 and slot_1 <= 9007199254740991" },
    { name: "auth_bucket_slot_2", expression: "slot_2 >= 0 and slot_2 <= 9007199254740991" },
    { name: "auth_bucket_slot_3", expression: "slot_3 >= 0 and slot_3 <= 9007199254740991" },
    { name: "auth_bucket_slot_4", expression: "slot_4 >= 0 and slot_4 <= 9007199254740991" },
    { name: "auth_bucket_slot_5", expression: "slot_5 >= 0 and slot_5 <= 9007199254740991" },
    { name: "auth_bucket_slot_6", expression: "slot_6 >= 0 and slot_6 <= 9007199254740991" },
    { name: "auth_bucket_slot_7", expression: "slot_7 >= 0 and slot_7 <= 9007199254740991" },
    { name: "auth_bucket_slot_8", expression: "slot_8 >= 0 and slot_8 <= 9007199254740991" },
    { name: "auth_bucket_slot_9", expression: "slot_9 >= 0 and slot_9 <= 9007199254740991" },
    { name: "auth_bucket_slot_10", expression: "slot_10 >= 0 and slot_10 <= 9007199254740991" },
    { name: "auth_bucket_slot_11", expression: "slot_11 >= 0 and slot_11 <= 9007199254740991" },
    { name: "auth_bucket_slot_12", expression: "slot_12 >= 0 and slot_12 <= 9007199254740991" },
    { name: "auth_bucket_slot_13", expression: "slot_13 >= 0 and slot_13 <= 9007199254740991" },
    { name: "auth_bucket_slot_14", expression: "slot_14 >= 0 and slot_14 <= 9007199254740991" },
    { name: "auth_bucket_slot_15", expression: "slot_15 >= 0 and slot_15 <= 9007199254740991" },
    { name: "auth_bucket_slot_16", expression: "slot_16 >= 0 and slot_16 <= 9007199254740991" },
    { name: "auth_bucket_slot_17", expression: "slot_17 >= 0 and slot_17 <= 9007199254740991" },
    { name: "auth_bucket_slot_18", expression: "slot_18 >= 0 and slot_18 <= 9007199254740991" },
    { name: "auth_bucket_slot_19", expression: "slot_19 >= 0 and slot_19 <= 9007199254740991" },
    { name: "auth_bucket_order", expression: "slot_0 <= slot_1 and slot_1 <= slot_2 and slot_2 <= slot_3 and slot_3 <= slot_4 and slot_4 <= slot_5 and slot_5 <= slot_6 and slot_6 <= slot_7 and slot_7 <= slot_8 and slot_8 <= slot_9 and slot_9 <= slot_10 and slot_10 <= slot_11 and slot_11 <= slot_12 and slot_12 <= slot_13 and slot_13 <= slot_14 and slot_14 <= slot_15 and slot_15 <= slot_16 and slot_16 <= slot_17 and slot_17 <= slot_18 and slot_18 <= slot_19" },
  ],
});
