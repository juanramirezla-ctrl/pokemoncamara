import { Injectable, computed, signal } from '@angular/core';
import type { MobileNet } from '@tensorflow-models/mobilenet';
import type { KNNClassifier } from '@tensorflow-models/knn-classifier';

export const BACKGROUND_LABEL = 'background';
export const SAMPLES_PER_CAPTURE = 20;
const BACKGROUND_CAPTURES = 3;
const NEIGHBORS = 10;

export interface Prediction {
  label: string;
  confidence: number;
}

export function requiredSamples(label: string): number {
  return label === BACKGROUND_LABEL ? SAMPLES_PER_CAPTURE * BACKGROUND_CAPTURES : SAMPLES_PER_CAPTURE;
}

@Injectable({ providedIn: 'root' })
export class RecognizerService {
  private net?: MobileNet;
  private classifier?: KNNClassifier;

  readonly chosenIds = signal<number[]>([]);
  readonly counts = signal<Record<string, number>>({});

  readonly trained = computed(() => {
    const counts = this.counts();
    const ids = this.chosenIds();
    return (
      ids.length === 3 &&
      [...ids.map(String), BACKGROUND_LABEL].every(
        (label) => (counts[label] ?? 0) >= requiredSamples(label)
      )
    );
  });

  async load(): Promise<void> {
    if (this.net) {
      return;
    }
    await import('@tensorflow/tfjs');
    const [mobilenet, knn] = await Promise.all([
      import('@tensorflow-models/mobilenet'),
      import('@tensorflow-models/knn-classifier'),
    ]);
    this.classifier = knn.create();
    this.net = await mobilenet.load();
  }

  // Cambiar de Pokémon borra lo aprendido; elegir los mismos lo conserva.
  choose(ids: number[]): void {
    if (ids.join() === this.chosenIds().join()) {
      return;
    }
    this.reset();
    this.chosenIds.set(ids);
  }

  // Borra lo aprendido pero conserva los Pokémon elegidos.
  reset(): void {
    this.classifier?.clearAllClasses();
    this.counts.set({});
  }

  addSample(source: HTMLCanvasElement, label: string): void {
    const { net, classifier } = this.engine();
    const activation = net.infer(source, true);
    classifier.addExample(activation, label);
    activation.dispose();
    this.counts.update((counts) => ({ ...counts, [label]: (counts[label] ?? 0) + 1 }));
  }

  async predict(source: HTMLCanvasElement): Promise<Prediction | null> {
    const { net, classifier } = this.engine();
    if (classifier.getNumClasses() === 0) {
      return null;
    }
    const activation = net.infer(source, true);
    try {
      const result = await classifier.predictClass(activation, NEIGHBORS);
      return { label: result.label, confidence: result.confidences[result.label] };
    } finally {
      activation.dispose();
    }
  }

  private engine(): { net: MobileNet; classifier: KNNClassifier } {
    if (!this.net || !this.classifier) {
      throw new Error('El reconocedor todavía no está cargado');
    }
    return { net: this.net, classifier: this.classifier };
  }
}