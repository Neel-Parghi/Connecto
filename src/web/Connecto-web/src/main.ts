import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { provideToastr } from 'ngx-toastr';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([])),
    provideAnimations(),
    provideToastr({
      timeOut: 3000, 
      positionClass: 'toast-top-right',
      preventDuplicates: true,   
      closeButton: true          
    }), provideAnimationsAsync(),
    provideHttpClient()
  ]
}).catch(err => console.error(err));