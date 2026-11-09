# E-day phone bank demo

## Demo links

| What | Link |
|---|---|
| Volunteer: main call list | https://avery-aidems.github.io/eday-pb-demo/index.html#t=demo-caller |
| Volunteer: mail-ballot (VBM) list | https://avery-aidems.github.io/eday-pb-demo/index.html#t=demo-vbm |
| Admin dashboard | https://avery-aidems.github.io/eday-pb-demo/admin.html#a=demo-admin |
| Volunteer, no "Demo" pill (screenshots) | https://avery-aidems.github.io/eday-pb-demo/index.html?clean#t=demo-caller |
| Admin, no "Demo" pill (screenshots) | https://avery-aidems.github.io/eday-pb-demo/admin.html?clean#a=demo-admin |
| Source repo | https://github.com/avery-aidems/eday-pb-demo |

The bare URLs ([volunteer](https://avery-aidems.github.io/eday-pb-demo/), [admin](https://avery-aidems.github.io/eday-pb-demo/admin.html)) also work. They open the main caller list and the admin view.

## Running the demo

- **Show live updates:** open a volunteer link and the admin link in two tabs of the same browser. Calls you log on the volunteer page appear on the admin dashboard within about 5 seconds.
- **Start over:** click **Reset** on the purple "Demo · synthetic data" pill in the bottom-left corner. Demo state is saved in the browser's localStorage, so it persists until you reset it or clear site data.
- **Screenshots:** add `?clean` to hide the Demo pill (see the links above).

## About this demo

- This is the real phone bank UI running on **synthetic data**. Every phone number starts with `999`, and no real voters or volunteers are included.
- There is **no backend.** `mock-backend.js` answers every API call inside the browser, and the page's CSP blocks network connections, so nothing leaves the browser.
- `robots.txt` asks search engines not to index the site.
