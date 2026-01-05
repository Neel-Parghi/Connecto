import { Routes } from '@angular/router';
import { LayoutComponent } from './shared/layout/layout.component';

export const routes: Routes = [
    {
        path:'',
        component: LayoutComponent,
        children:[
            { path: '', loadChildren: () => import('./features/auth/auth.routes').then(m => m.AUTH_ROUTES) },
            { path:'random-chat', loadChildren: () => import('./features/chats/chat.routes').then(m => m.CHAT_ROUTES) },
        ]
    }
];
