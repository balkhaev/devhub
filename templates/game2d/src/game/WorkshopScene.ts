import Phaser from "phaser";

/** Procedural art keeps this starter self-contained; the simulation lives in engine.ts. */
export class WorkshopScene extends Phaser.Scene {
  private readonly onCollect: () => void;
  private counter?: Phaser.GameObjects.Text;
  private core?: Phaser.GameObjects.Container;

  constructor(onCollect: () => void) {
    super("workshop");
    this.onCollect = onCollect;
  }

  create(): void {
    const g = this.add.graphics();
    g.fillStyle(0x18221d).fillRect(0, 0, 1000, 620);
    g.lineStyle(1, 0x2b3830, 0.55);
    for (let x = -600; x < 1600; x += 64) {
      g.lineBetween(x, 0, x + 620, 620);
      g.lineBetween(x, 620, x + 620, 0);
    }
    g.fillStyle(0x202e26).fillRoundedRect(115, 102, 770, 430, 18);
    g.lineStyle(2, 0x3b4d3e).strokeRoundedRect(115, 102, 770, 430, 18);
    g.fillStyle(0x111b16).fillRoundedRect(145, 300, 705, 102, 8);
    g.fillStyle(0x2c3c31).fillRoundedRect(150, 309, 690, 79, 6);
    for (let x = 164; x < 834; x += 20) {
      g.fillStyle(0x465748).fillRect(x, 313, 4, 71);
    }
    g.lineStyle(9, 0x62775d).lineBetween(218, 213, 763, 213);
    g.lineStyle(4, 0x96a375).lineBetween(218, 211, 763, 211);
    this.add.text(155, 133, "ОТДЕЛ ПЕРЕРАБОТКИ / 01", { fontFamily: "monospace", fontSize: "14px", color: "#94a38b", letterSpacing: 2 });
    this.add.text(668, 489, "ЦЕХ РАБОТАЕТ", { fontFamily: "monospace", fontSize: "13px", color: "#acc391", letterSpacing: 2 });
    this.add.circle(646, 498, 4, 0xc3d48e);

    this.machine(202, 180, 125, 0x405548, "СЫРЬЁ");
    this.machine(688, 180, 135, 0x4e6142, "СКЛАД");
    this.core = this.add.container(497, 302);
    const body = this.add.rectangle(0, 0, 183, 166, 0x324736).setStrokeStyle(3, 0x738765);
    const roof = this.add.rectangle(0, -95, 205, 22, 0x839675);
    const ring = this.add.circle(0, -10, 54, 0x18241a).setStrokeStyle(5, 0xacc68b);
    const gem = this.add.polygon(0, -12, [26, 0, 52, 26, 26, 67, 0, 26], 0xd4e6a2).setStrokeStyle(2, 0xecf7c9);
    const label = this.add.text(0, 65, "СОБРАТЬ", { fontFamily: "monospace", fontSize: "13px", color: "#e0edbc", letterSpacing: 3 }).setOrigin(0.5);
    this.core.add([body, roof, ring, gem, label]);
    ring.setInteractive({ useHandCursor: true });
    ring.on("pointerdown", () => this.onCollect());
    this.tweens.add({ targets: gem, y: -20, duration: 1250, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.tweens.add({ targets: ring, alpha: 0.6, duration: 1900, yoyo: true, repeat: -1 });

    for (let item = 0; item < 6; item += 1) {
      const crate = this.add.rectangle(170 + item * 110, 350, 22, 22, 0xacb47a).setStrokeStyle(2, 0xd2dca2);
      this.tweens.add({ targets: crate, x: 820, duration: (650 - item * 110) * 15, onComplete: () => {
        crate.x = 170;
        this.tweens.add({ targets: crate, x: 820, duration: 9750, repeat: -1 });
      } });
    }
    for (let i = 0; i < 4; i += 1) {
      const lamp = this.add.circle(195 + i * 203, 439, 6, 0xc1cf93);
      this.tweens.add({ targets: lamp, alpha: 0.45, duration: 1700 + i * 120, repeat: -1, yoyo: true });
    }
    this.counter = this.add.text(152, 485, "УРОВЕНЬ 01", { fontFamily: "monospace", fontSize: "14px", color: "#b6c3a7", letterSpacing: 2 });
  }

  private machine(x: number, y: number, width: number, color: number, title: string): void {
    const g = this.add.graphics();
    g.fillStyle(color).fillRoundedRect(x, y, width, 101, 6);
    g.lineStyle(2, 0x77896b).strokeRoundedRect(x, y, width, 101, 6);
    g.fillStyle(0x1b281e).fillRect(x + 18, y + 18, width - 36, 38);
    this.add.text(x + width / 2, y + 78, title, { fontFamily: "monospace", fontSize: "12px", color: "#c4d3ac", letterSpacing: 2 }).setOrigin(0.5);
    for (let i = 0; i < 3; i += 1) this.add.rectangle(x + 29 + i * 28, y + 36, 11, 11, 0xa9c485);
  }

  setLevel(level: number): void {
    this.counter?.setText(`УРОВЕНЬ ${String(level + 1).padStart(2, "0")}`);
  }

  pulse(amount: number): void {
    if (!this.core || !this.scene.isActive()) return;
    const popup = this.add.text(500, 250, `+${amount.toFixed(1)}`, { fontFamily: "monospace", fontSize: "23px", color: "#e4efbd" }).setOrigin(0.5);
    this.tweens.add({ targets: popup, y: 196, alpha: 0, duration: 650, onComplete: () => popup.destroy() });
    this.tweens.add({ targets: this.core, scaleX: 1.035, scaleY: 1.035, duration: 80, yoyo: true });
  }
}
