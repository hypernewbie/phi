" Phi Copper Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_copper"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#e59866 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#e59866
hi IncSearch        guifg=#14141a guibg=#d35400
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#e59866 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#e59866 guibg=#1f1f26  gui=bold
hi Directory        guifg=#d35400

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#e59866
hi String           guifg=#f5cba7
hi Character        guifg=#f5cba7
hi Number           guifg=#e59866
hi Boolean          guifg=#e59866
hi Float            guifg=#e59866

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#d35400

hi Statement        guifg=#e59866 gui=bold
hi Conditional      guifg=#e59866 gui=bold
hi Repeat           guifg=#e59866 gui=bold
hi Label            guifg=#e59866
hi Operator         guifg=#d35400
hi Keyword          guifg=#e59866 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#873600
hi Include          guifg=#873600
hi Define           guifg=#873600
hi Macro            guifg=#873600
hi PreCondit        guifg=#873600

hi Type             guifg=#873600 gui=bold
hi StorageClass     guifg=#873600
hi Structure        guifg=#873600
hi Typedef          guifg=#873600

hi Special          guifg=#e59866
hi SpecialChar      guifg=#f5cba7
hi Tag              guifg=#d35400
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#d35400    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#e59866  guibg=#1f1f26  gui=bold
