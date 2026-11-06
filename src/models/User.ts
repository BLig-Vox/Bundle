import { Collection, EntitySchema, ReferenceKind, OptionalProps } from "@mikro-orm/core";
import { Post } from "./Post.ts";

/** Example persistence model, not an authentication implementation. */
export class User {
  [OptionalProps]?: "createdAt" | "updatedAt" | "posts";
  id!: number;
  name!: string;
  email!: string;
  createdAt = new Date();
  updatedAt = new Date();
  posts = new Collection<Post>(this);
}

export default new EntitySchema<User>({
  class: User,
  tableName: "users",
  properties: {
    id: { type: "number", primary: true },
    name: { type: "string", length: 120 },
    email: { type: "string", length: 254, unique: true },
    createdAt: { type: Date },
    updatedAt: { type: Date, onUpdate: () => new Date() },
    posts: { kind: ReferenceKind.ONE_TO_MANY, entity: () => Post, mappedBy: "author" },
  },
});
