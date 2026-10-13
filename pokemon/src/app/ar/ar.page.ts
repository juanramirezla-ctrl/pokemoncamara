import { DecimalPipe } from '@angular/common';
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import {
  NavController,
  IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonButton,
  IonContent, IonSpinner, IonItem, IonSelect, IonSelectOption
} from '@ionic/angular';
import { PokemonService } from '../services/pokemon.service';
import {
  BACKGROUND_LABEL, RecognizerService, SAMPLES_PER_CAPTURE, requiredSamples, type Prediction
} from '../services/recognizer.service';

type Mode = 'select' | 'train' | 'detect';

const UNKNOWN_LABEL = 'unknown';
const INPUT_SIZE = 224;
const MIN_CONFIDENCE = 0.8;
const STABLE_FRAMES = 3;
const DETECT_INTERVAL_MS = 200;
const CAPTURE_INTERVAL_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Component({
  selector: 'app-ar',
  templateUrl: './ar.page.html',
  styleUrls: ['./ar.page.scss'],
  standalone: true,
  imports: [
    DecimalPipe,
    IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonButton,
    IonContent, IonSpinner, IonItem, IonSelect, IonSelectOption
  ]
})
export class ArPage {
  private navCtrl = inject(NavController);
  private pokemonService = inject(PokemonService);
  private recognizer = inject(RecognizerService);
  private video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private guide = viewChild.required<ElementRef<HTMLDivElement>>('guide');

  private readonly canvas = document.createElement('canvas');
  private stream?: MediaStream;
  private runId = 0;
  private candidate = BACKGROUND_LABEL;
  private streak = 0;

  readonly slots = [0, 1, 2];
  readonly samplesPerCapture = SAMPLES_PER_CAPTURE;
  readonly pokemons = this.pokemonService.pokemons;
  readonly trained = this.recognizer.trained;

  readonly mode = signal<Mode>(this.initialMode());
  readonly selection = signal<(number | null)[]>(this.initialSelection());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly capturing = signal<string | null>(null);
  readonly detected = signal(BACKGROUND_LABEL);

  readonly canContinue = computed(() => {
    const ids = this.selection();
    return ids.every((id) => id !== null) && new Set(ids).size === ids.length;
  });

  readonly trainRows = computed(() => {
    const counts = this.recognizer.counts();
    const rows = this.recognizer.chosenIds().map((id) => ({
      label: String(id),
      name: this.pokemonService.getById(id)?.name ?? `#${id}`,
    }));
    return [...rows, { label: BACKGROUND_LABEL, name: 'Fondo (sin ningún Pokémon)' }].map((row) => ({
      ...row,
      count: counts[row.label] ?? 0,
      required: requiredSamples(row.label),
    }));
  });

  readonly detectedPokemon = computed(() => {
    const label = this.detected();
    return label === BACKGROUND_LABEL || label === UNKNOWN_LABEL
      ? undefined
      : this.pokemonService.getById(Number(label));
  });

  readonly isUnknown = computed(() => this.detected() === UNKNOWN_LABEL);

  constructor() {
    this.canvas.width = INPUT_SIZE;
    this.canvas.height = INPUT_SIZE;
  }

  ionViewDidEnter(): void {
    if (this.mode() !== 'select') {
      void this.prepare(this.mode());
    }
  }

  ionViewWillLeave(): void {
    this.stopDetection();
    this.stopCamera();
  }

  select(slot: number, event: CustomEvent): void {
    this.selection.update((ids) => ids.map((id, i) => (i === slot ? event.detail.value : id)));
  }

  async continue(): Promise<void> {
    const ids = this.selection().filter((id): id is number => id !== null);
    this.recognizer.choose(ids);
    await this.prepare(this.trained() ? 'detect' : 'train');
  }

  async capture(label: string): Promise<void> {
    this.capturing.set(label);
    try {
      for (let i = 0; i < SAMPLES_PER_CAPTURE && this.stream; i++) {
        this.recognizer.addSample(this.captureFrame(), label);
        await sleep(CAPTURE_INTERVAL_MS);
      }
    } finally {
      this.capturing.set(null);
    }
  }

  resetTraining(): void {
    this.recognizer.reset();
  }

  startDetect(): void {
    this.mode.set('detect');
    this.startDetection();
  }

  backToTrain(): void {
    this.stopDetection();
    this.mode.set('train');
  }

  changePokemon(): void {
    this.stopDetection();
    this.stopCamera();
    this.mode.set('select');
  }

  openDetail(id: number): void {
    this.navCtrl.navigateForward(['/pokemon-detail', id]);
  }

  private async prepare(mode: Mode): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.recognizer.load();
      await this.startCamera();
      this.mode.set(mode);
      if (mode === 'detect') {
        this.startDetection();
      }
    } catch (error) {
      console.error('No se pudo preparar el detector', error);
      this.error.set(
        'No se pudo abrir la cámara o cargar el modelo. Revisa los permisos, la conexión y que la página use HTTPS.'
      );
      this.mode.set('select');
    } finally {
      this.loading.set(false);
    }
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    const video = this.video().nativeElement;
    video.srcObject = stream;
    await video.play();
    this.stream = stream;
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video().nativeElement.srcObject = null;
  }

  // Recorta del video solo la zona del cuadro guía, para que el modelo ignore el resto de la escena.
  private captureFrame(): HTMLCanvasElement {
    const context = this.canvas.getContext('2d');
    if (!context) {
      throw new Error('No se pudo procesar el video');
    }
    const video = this.video().nativeElement;
    const view = video.getBoundingClientRect();
    const guide = this.guide().nativeElement.getBoundingClientRect();

    // El video se muestra con object-fit: cover, centrado: se calcula qué parte del cuadro original se ve.
    const scale = Math.max(view.width / video.videoWidth, view.height / video.videoHeight);
    const sx = (guide.left - view.left + (video.videoWidth * scale - view.width) / 2) / scale;
    const sy = (guide.top - view.top + (video.videoHeight * scale - view.height) / 2) / scale;
    const side = guide.width / scale;

    context.drawImage(video, sx, sy, side, side, 0, 0, INPUT_SIZE, INPUT_SIZE);
    return this.canvas;
  }

  private startDetection(): void {
    const run = ++this.runId;
    this.candidate = BACKGROUND_LABEL;
    this.streak = 0;
    this.detected.set(BACKGROUND_LABEL);
    void this.detectLoop(run);
  }

  private stopDetection(): void {
    this.runId++;
  }

  private async detectLoop(run: number): Promise<void> {
    try {
      while (run === this.runId) {
        this.handlePrediction(await this.recognizer.predict(this.captureFrame()));
        await sleep(DETECT_INTERVAL_MS);
      }
    } catch (error) {
      if (run === this.runId) {
        console.error('Falló la detección', error);
        this.error.set('Falló la detección. Vuelve a intentarlo.');
      }
    }
  }

  // El resultado solo cambia cuando se repite en varios cuadros seguidos, para que no parpadee.
  private handlePrediction(prediction: Prediction | null): void {
    const label =
      prediction && prediction.confidence >= MIN_CONFIDENCE ? prediction.label : UNKNOWN_LABEL;
    this.streak = label === this.candidate ? this.streak + 1 : 1;
    this.candidate = label;
    if (this.streak >= STABLE_FRAMES) {
      this.detected.set(label);
    }
  }

  private initialMode(): Mode {
    if (this.recognizer.trained()) {
      return 'detect';
    }
    return this.recognizer.chosenIds().length === 3 ? 'train' : 'select';
  }

  private initialSelection(): (number | null)[] {
    const ids = this.recognizer.chosenIds();
    return ids.length === 3 ? [...ids] : [null, null, null];
  }
}