import { Routes } from '@angular/router';
import { GuestLoginComponent } from './guest-login/guest-login.component';

export const AUTH_ROUTES: Routes = [
  { path:'', component: GuestLoginComponent },
];