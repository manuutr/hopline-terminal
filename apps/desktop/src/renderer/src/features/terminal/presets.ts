import type { TermColors } from '@shared/ux'

/** Fixed Hopline palettes in terminal ANSI order. */
export const HOPLINE_PRESETS = [
  {
    id: 'cobalt', label: 'Cobalt',
    colors: {
      background: '#101c3b', foreground: '#e2ecff', cursor: '#80dbff', cursorAccent: '#101c3b', selectionBackground: '#314775',
      black: '#242f54', red: '#ff8b9a', green: '#82e6ad', yellow: '#f9cd6c', blue: '#84bcff', magenta: '#cba3ff', cyan: '#64e1ee', white: '#c9d3e7',
      brightBlack: '#92a4cf', brightRed: '#ffa9b4', brightGreen: '#a2ecc2', brightYellow: '#fbda92', brightBlue: '#a4cdff', brightMagenta: '#d9bbff', brightCyan: '#8ce9f2', brightWhite: '#f0f6ff'
    }
  },
  {
    id: 'deep-sea', label: 'Deep Sea',
    colors: {
      background: '#09272d', foreground: '#d3efed', cursor: '#61e5c2', cursorAccent: '#09272d', selectionBackground: '#194d51',
      black: '#173c42', red: '#ff9587', green: '#6ed9a9', yellow: '#f6c97c', blue: '#79bfea', magenta: '#ccabdf', cyan: '#50ded4', white: '#bbd7d6',
      brightBlack: '#81a9ab', brightRed: '#ffb1a6', brightGreen: '#94e3bf', brightYellow: '#f8d79e', brightBlue: '#9cd0ef', brightMagenta: '#d9c1e7', brightCyan: '#7ee7df', brightWhite: '#e9f7f6'
    }
  },
  {
    id: 'aubergine', label: 'Aubergine',
    colors: {
      background: '#291a2b', foreground: '#f3e4ef', cursor: '#eaa2cf', cursorAccent: '#291a2b', selectionBackground: '#513149',
      black: '#3d293c', red: '#f896a3', green: '#b3d68c', yellow: '#f5c98a', blue: '#a6b7f0', magenta: '#dba1e7', cyan: '#8cd8ce', white: '#dbccd7',
      brightBlack: '#b898ae', brightRed: '#fab1bb', brightGreen: '#c7e1aa', brightYellow: '#f8d7a8', brightBlue: '#bdcaf4', brightMagenta: '#e4b9ed', brightCyan: '#aae2db', brightWhite: '#f9f2f7'
    }
  },
  {
    id: 'forest', label: 'Forest',
    colors: {
      background: '#16261c', foreground: '#e2edcd', cursor: '#cae89a', cursorAccent: '#16261c', selectionBackground: '#354834',
      black: '#263b2b', red: '#f6a08b', green: '#a6d67f', yellow: '#e9c77e', blue: '#92bdd3', magenta: '#c8a9d5', cyan: '#86ceb0', white: '#cad5b8',
      brightBlack: '#99aa8b', brightRed: '#f8b9a9', brightGreen: '#bde1a0', brightYellow: '#efd6a0', brightBlue: '#aecede', brightMagenta: '#d6bfe0', brightCyan: '#a5dbc5', brightWhite: '#f0f6e6'
    }
  },
  {
    id: 'amber-glass', label: 'Amber Glass',
    colors: {
      background: '#241c13', foreground: '#f2d3a1', cursor: '#ffd064', cursorAccent: '#241c13', selectionBackground: '#4f3924',
      black: '#3c2c1b', red: '#ff9978', green: '#c5d88d', yellow: '#f6c65d', blue: '#a8bfd0', magenta: '#dfabd0', cyan: '#8fd0bc', white: '#d9bd90',
      brightBlack: '#b09774', brightRed: '#ffb49b', brightGreen: '#d4e2ab', brightYellow: '#f8d587', brightBlue: '#bfd0dc', brightMagenta: '#e7c1dc', brightCyan: '#acdccd', brightWhite: '#f8e9d0'
    }
  },
  {
    id: 'green-phosphor', label: 'Green Phosphor',
    colors: {
      background: '#07180e', foreground: '#a4edb2', cursor: '#75ff9a', cursorAccent: '#07180e', selectionBackground: '#17482a',
      black: '#183321', red: '#ff9b91', green: '#76ed91', yellow: '#e5d477', blue: '#93bcfa', magenta: '#d6a6e4', cyan: '#75ded0', white: '#91d39e',
      brightBlack: '#82ac8b', brightRed: '#ffb5ae', brightGreen: '#9af2ae', brightYellow: '#ecdf9a', brightBlue: '#afcdfb', brightMagenta: '#e1bdeb', brightCyan: '#99e7dc', brightWhite: '#d2f6d8'
    }
  },
  {
    id: 'glacier', label: 'Glacier',
    colors: {
      background: '#eaf4f8', foreground: '#213641', cursor: '#006780', cursorAccent: '#eaf4f8', selectionBackground: '#c4e0eb',
      black: '#182c35', red: '#af354a', green: '#19694b', yellow: '#805b12', blue: '#235f99', magenta: '#814585', cyan: '#006a72', white: '#394d57',
      brightBlack: '#596e78', brightRed: '#8c2a3b', brightGreen: '#14543c', brightYellow: '#66490e', brightBlue: '#1c4c7a', brightMagenta: '#67376a', brightCyan: '#00555b', brightWhite: '#101b20'
    }
  },
  {
    id: 'sandstone', label: 'Sandstone',
    colors: {
      background: '#f8edd9', foreground: '#473423', cursor: '#985017', cursorAccent: '#f8edd9', selectionBackground: '#e8ceab',
      black: '#362519', red: '#a53a2c', green: '#4c652d', yellow: '#835911', blue: '#385e89', magenta: '#88416b', cyan: '#236964', white: '#5c4a39',
      brightBlack: '#74614c', brightRed: '#842e23', brightGreen: '#3d5124', brightYellow: '#69470e', brightBlue: '#2d4b6e', brightMagenta: '#6d3456', brightCyan: '#1c5450', brightWhite: '#241a12'
    }
  },
  {
    id: 'porcelain', label: 'Porcelain',
    colors: {
      background: '#fafbfd', foreground: '#243145', cursor: '#3b54ac', cursorAccent: '#fafbfd', selectionBackground: '#d4e1f5',
      black: '#1e2731', red: '#a72e4b', green: '#236941', yellow: '#806004', blue: '#315eba', magenta: '#75439c', cyan: '#006a77', white: '#3e495b',
      brightBlack: '#617082', brightRed: '#86253c', brightGreen: '#1c5434', brightYellow: '#664d03', brightBlue: '#274b95', brightMagenta: '#5e367d', brightCyan: '#00555f', brightWhite: '#121822'
    }
  },
  {
    id: 'lavender', label: 'Lavender',
    colors: {
      background: '#f3edf9', foreground: '#382d49', cursor: '#764692', cursorAccent: '#f3edf9', selectionBackground: '#decfea',
      black: '#2c233b', red: '#a03857', green: '#376849', yellow: '#795913', blue: '#5056a0', magenta: '#87418d', cyan: '#176973', white: '#4e445e',
      brightBlack: '#71667d', brightRed: '#802d46', brightGreen: '#2c533a', brightYellow: '#61470f', brightBlue: '#404580', brightMagenta: '#6c3471', brightCyan: '#12545c', brightWhite: '#1c1624'
    }
  },
  {
    id: 'sage', label: 'Sage',
    colors: {
      background: '#edf3e6', foreground: '#2e3c2b', cursor: '#366c45', cursorAccent: '#edf3e6', selectionBackground: '#d0dfc6',
      black: '#202d20', red: '#a23c37', green: '#33683c', yellow: '#735a1a', blue: '#3d6091', magenta: '#804674', cyan: '#1f6963', white: '#455241',
      brightBlack: '#5e705c', brightRed: '#82302c', brightGreen: '#295330', brightYellow: '#5c4815', brightBlue: '#314d74', brightMagenta: '#66385d', brightCyan: '#19544f', brightWhite: '#171e16'
    }
  }
] satisfies { id: string; label: string; colors: TermColors }[]
