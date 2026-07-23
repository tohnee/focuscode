import { randomUUID } from "node:crypto";

export interface SteeringItem {
  id: string;
  text: string;
  mode: "append" | "interrupt" | "follow-up";
  createdAt: string;
}

export class SteeringQueue {
  private readonly items: SteeringItem[] = [];

  constructor(
    private readonly maximum = 32,
    private readonly now: () => Date = () => new Date(),
  ) {}

  enqueue(text: string, mode: SteeringItem["mode"] = "append"): SteeringItem {
    const prompt = text.trim();
    if (!prompt) throw new Error("Steering text must not be empty");
    if (this.items.length >= this.maximum) throw new Error("Steering queue is full");
    const item: SteeringItem = {
      id: "steer_" + randomUUID(),
      text: prompt,
      mode,
      createdAt: this.now().toISOString(),
    };
    this.items.push(item);
    return structuredClone(item);
  }

  drain(modes?: SteeringItem["mode"][]): SteeringItem[] {
    if (!modes) return this.items.splice(0).map((item) => structuredClone(item));
    const accepted = new Set(modes);
    const drained = this.items.filter((item) => accepted.has(item.mode));
    const retained = this.items.filter((item) => !accepted.has(item.mode));
    this.items.splice(0, this.items.length, ...retained);
    return drained.map((item) => structuredClone(item));
  }

  drainOne(modes?: SteeringItem["mode"][]): SteeringItem | undefined {
    const accepted = modes ? new Set(modes) : undefined;
    const index = this.items.findIndex((item) => !accepted || accepted.has(item.mode));
    if (index < 0) return undefined;
    const [item] = this.items.splice(index, 1);
    return item ? structuredClone(item) : undefined;
  }

  remove(id: string): SteeringItem | undefined {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [item] = this.items.splice(index, 1);
    return item ? structuredClone(item) : undefined;
  }

  removeLatest(mode?: SteeringItem["mode"]): SteeringItem | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      if (!item || (mode && item.mode !== mode)) continue;
      this.items.splice(index, 1);
      return structuredClone(item);
    }
    return undefined;
  }

  list(): SteeringItem[] {
    return this.items.map((item) => structuredClone(item));
  }

  get size(): number {
    return this.items.length;
  }
}
