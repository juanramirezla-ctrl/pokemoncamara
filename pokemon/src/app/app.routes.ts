import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'pokemon-detail/:id',
    loadComponent: () => import('./pokemon-detail/pokemon-detail.page').then((m) => m.PokemonDetailPage),
  },
    {
    path: 'pokemon-form',
    loadComponent: () => import('./pokemon-form/pokemon-form.page').then((m) => m.PokemonFormPage),
  },
  {
    path: 'pokemon-form/:id',
    loadComponent: () => import('./pokemon-form/pokemon-form.page').then((m) => m.PokemonFormPage),
  },
    {
    path: 'ar',
    loadComponent: () => import('./ar/ar.page').then((m) => m.ArPage),
  },
];