import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { finalize, forkJoin, map, switchMap } from 'rxjs';
import { Pokemon, PokemonInput } from '../models/pokemon.model';
import { calculateWeaknesses } from '../utils/weaknesses';

interface PokemonListResponse {
  results: { url: string }[];
}

interface PokemonApiDetail {
  id: number;
  name: string;
  height: number;
  weight: number;
  sprites: {
    front_default: string | null;
    other?: { 'official-artwork'?: { front_default: string | null } };
  };
  types: { type: { name: string } }[];
  stats: { base_stat: number; stat: { name: string } }[];
}

const API_URL = 'https://pokeapi.co/api/v2/pokemon';
const CUSTOM_KEY = 'custom-pokemons';
const EDITS_KEY = 'edited-pokemons';
const DELETED_KEY = 'deleted-pokemons';
const FIRST_CUSTOM_ID = 900; // la API solo se carga hasta el #151

function toPokemon(d: PokemonApiDetail): Pokemon {
  const types = d.types.map((t) => t.type.name);
  return {
    id: d.id,
    name: d.name,
    image: d.sprites.other?.['official-artwork']?.front_default ?? d.sprites.front_default ?? '',
    types,
    weaknesses: calculateWeaknesses(types),
    height: d.height / 10,
    weight: d.weight / 10,
    stats: d.stats.map((s) => ({ name: s.stat.name, value: s.base_stat })),
  };
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

@Injectable({ providedIn: 'root' })
export class PokemonService {
  private http = inject(HttpClient);

  private apiPokemons = signal<Pokemon[]>([]);
  private customPokemons = signal<Pokemon[]>(readStorage<Pokemon[]>(CUSTOM_KEY, []));
  private edits = signal<Record<number, Pokemon>>(readStorage<Record<number, Pokemon>>(EDITS_KEY, {}));
  private deletedIds = signal<number[]>(readStorage<number[]>(DELETED_KEY, []));

  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly hasDeleted = computed(() => this.deletedIds().length > 0);

  readonly pokemons = computed(() => {
    const edits = this.edits();
    const deleted = this.deletedIds();
    const fromApi = this.apiPokemons()
      .filter((p) => !deleted.includes(p.id))
      .map((p) => edits[p.id] ?? p);
    return [...fromApi, ...this.customPokemons()];
  });

  constructor() {
    this.load();
  }

  getById(id: number): Pokemon | undefined {
    return this.pokemons().find((p) => p.id === id);
  }

  isEdited(id: number): boolean {
    return id in this.edits();
  }

  create(data: PokemonInput): Pokemon {
    const pokemon: Pokemon = { ...data, id: this.nextCustomId(), isCustom: true };
    this.saveCustom([...this.customPokemons(), pokemon]);
    return pokemon;
  }

  update(id: number, data: PokemonInput): void {
    if (this.customPokemons().some((p) => p.id === id)) {
      this.saveCustom(this.customPokemons().map((p) => (p.id === id ? { ...p, ...data } : p)));
      return;
    }

    const original = this.apiPokemons().find((p) => p.id === id);
    if (original) {
      this.saveEdits({ ...this.edits(), [id]: { ...original, ...data } });
    }
  }

  remove(id: number): void {
    if (this.customPokemons().some((p) => p.id === id)) {
      this.saveCustom(this.customPokemons().filter((p) => p.id !== id));
    } else if (this.apiPokemons().some((p) => p.id === id)) {
      this.saveDeleted([...this.deletedIds(), id]);
    }
  }

  // Devuelve un Pokémon de la API a sus datos originales.
  restore(id: number): void {
    const edits = { ...this.edits() };
    delete edits[id];
    this.saveEdits(edits);
  }

  restoreDeleted(): void {
    this.saveDeleted([]);
  }

  load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);

    this.http
      .get<PokemonListResponse>(`${API_URL}?limit=151`)
      .pipe(
        switchMap((res) =>
          forkJoin(res.results.map((p) => this.http.get<PokemonApiDetail>(p.url)))
        ),
        map((details) => details.map(toPokemon)),
        finalize(() => this.loading.set(false))
      )
      .subscribe({
        next: (pokemons) => this.apiPokemons.set(pokemons),
        error: (err) => {
          console.error('No se pudo cargar la PokeAPI', err);
          this.loadFailed.set(true);
        },
      });
  }

  private nextCustomId(): number {
    return Math.max(FIRST_CUSTOM_ID - 1, ...this.customPokemons().map((p) => p.id)) + 1;
  }

  private saveCustom(list: Pokemon[]): void {
    this.customPokemons.set(list);
    writeStorage(CUSTOM_KEY, list);
  }

  private saveEdits(edits: Record<number, Pokemon>): void {
    this.edits.set(edits);
    writeStorage(EDITS_KEY, edits);
  }

  private saveDeleted(ids: number[]): void {
    this.deletedIds.set(ids);
    writeStorage(DELETED_KEY, ids);
  }
}