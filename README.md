# entropixel-bot
Bot for Konfur 2023 entropixel

# main.py
Contains 2 commands:
1. create <path_to_image> <width> <height> <chunk_size> <x> <y> - generate scripts that this image
2. split <path_to_json> <chunk_size> - split json with points to chunks of exact size

# script.js
Contains template of script that can draw images on board. Just fill POINTS variable and put this code into dev-console in browser

# editor.js
Contains simple editor that can display current START, END, DESTINATION points and size of selected area. Start should be higher and more left than end.

- ctrl + click on any pixel - set start

- ctrl + shift + click on any pixel - set end

- shift + click on any pixel - set destination

- middle click - reset start, end, destination

- s key - download json that delete previous area and draw new area

- w key - download json that only draw new area
